// Native (client-composed) tools for the pump.fun MCP bridge.
//
// These don't exist on the backend as single endpoints — they orchestrate
// several backend read tools and add value on top (here: a deep-link into the
// three.ws /coin3d viewer). Keeping them in the bridge means the package is
// useful the moment it's installed, with no backend deploy required, while
// still sourcing every number from the same canonical on-chain reads.

import { isSolanaAddress } from './base58.js';
import { NO_DATA, INVALID_PARAMS, ToolError } from './errors.js';
import { deadline } from './signal.js';
import { fetchPublicJson, toPublicHttpsUrl } from './url.js';

/** @typedef {import('@modelcontextprotocol/sdk/types.js').Tool} Tool */
/** @typedef {Record<string, unknown>} Json */
/**
 * Invokes one backend tool and resolves its structuredContent.
 * @typedef {(name: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<Json | null>} CallBackendTool
 */
/**
 * @typedef {object} NativeContext
 * @property {(name: string, args?: Record<string, unknown>) => Promise<Json | null>} call
 *   Backend tool call, already bound to the request's cancellation signal.
 * @property {string} siteBase Public site origin for viewer links.
 * @property {AbortSignal} [signal] The MCP request's cancellation signal.
 */
/** @typedef {(args: Record<string, unknown>, ctx: NativeContext) => Promise<Json>} NativeHandler */
/** @typedef {(args: Record<string, unknown>, signal?: AbortSignal) => Promise<Json>} NativeEntry */

// Derive the public site origin (for viewer links) from the backend URL, so a
// self-hosted backend produces self-hosted viewer links automatically.
/** @param {string} backendUrl */
function siteBaseFrom(backendUrl) {
	try {
		return new URL(backendUrl).origin;
	} catch {
		return 'https://three.ws';
	}
}

/**
 * @param {unknown} v
 * @returns {Json}
 */
function obj(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Json} */ (v) : {};
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

// The token logo lives in the off-chain metadata JSON pointed to by the
// on-chain `uri`. Resolve it best-effort: a direct image field wins, otherwise
// fetch the uri JSON and read .image. Returns null rather than guessing.
//
// Both the uri and the image are creator-controlled, so they go through the
// public-HTTPS guard in url.js: no private hosts, no non-https schemes, and a
// size-capped body. The returned image is always a public https URL or null.
/**
 * @param {Json} d get_token_details structuredContent
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | null>}
 */
async function resolveImage(d, signal) {
	const meta = obj(d.metadata);
	const direct = str(d.image) || str(d.imageUrl) || str(meta.image);
	if (direct) return toPublicHttpsUrl(direct);
	const uri = str(d.uri) || str(meta.uri);
	if (!uri) return null;
	const limit = deadline(6000, signal);
	try {
		const json = obj(await fetchPublicJson(uri, { signal: limit.signal }));
		return toPublicHttpsUrl(json.image);
	} catch {
		return null;
	} finally {
		limit.dispose();
	}
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function num(v) {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * A raw base-unit amount as a bigint, or null when it is not a non-negative
 * integer (string or safe integer).
 *
 * @param {unknown} v
 * @returns {bigint | null}
 */
function rawAmount(v) {
	if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
	if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
	return null;
}

/**
 * `part / whole` as a percentage with 4 decimal places, computed on the raw
 * integer amounts so large supplies keep full precision.
 *
 * @param {bigint} part
 * @param {bigint} whole
 * @returns {number | null}
 */
function percentOf(part, whole) {
	if (whole <= 0n) return null;
	return Number((part * 1_000_000n) / whole) / 10_000;
}

// pumpfun_token_3d — assemble a live 3D snapshot of a token and return a
// shareable viewer deep-link plus the underlying data.
/** @type {NativeHandler} */
async function token3dHandler(args, { call, siteBase, signal }) {
	const mint = typeof args?.mint === 'string' ? args.mint.trim() : '';
	if (!mint) {
		throw new ToolError('mint is required', INVALID_PARAMS);
	}
	if (!isSolanaAddress(mint)) {
		throw new ToolError('mint must be a base58 Solana address (32 bytes)', INVALID_PARAMS);
	}
	const network = args?.network === 'devnet' ? 'devnet' : 'mainnet';

	// Canonical (snake_case) names: the spelling the backend advertises in
	// tools/list. The legacy camelCase aliases still resolve, but only as a
	// compatibility path.
	const [details, curve, holders] = await Promise.allSettled([
		call('get_token_details', { mint }),
		call('get_bonding_curve', { mint, network }),
		call('get_token_holders', { mint, limit: 12, network }),
	]);

	if (
		details.status === 'rejected' &&
		curve.status === 'rejected' &&
		holders.status === 'rejected'
	) {
		const reason = details.reason instanceof Error ? details.reason.message : 'unavailable';
		throw new ToolError(`no on-chain data for ${mint}: ${reason}`, NO_DATA);
	}

	const d = details.status === 'fulfilled' ? obj(details.value) : {};
	const c = curve.status === 'fulfilled' ? obj(curve.value) : {};
	const h = holders.status === 'fulfilled' ? obj(holders.value) : null;
	const curveKnown = Object.keys(c).length > 0;

	const meta = obj(d.metadata);
	const name = str(d.name) || str(meta.name);
	const symbol = str(d.symbol) || str(meta.symbol);
	const image = await resolveImage(d, signal);

	// get_bonding_curve's contract: `complete` (bool) and `graduationPercent`
	// (0–100). Normalised here to a 0–1 fraction for the viewer.
	const graduated = curveKnown && c.complete === true;
	const percent = curveKnown ? num(c.graduationPercent) : null;
	const graduationProgress = graduated
		? 1
		: percent === null
			? null
			: Math.max(0, Math.min(1, percent / 100));

	// Holder share is measured against the mint's total supply. The backend's
	// per-holder `percent` is a share of the returned holders only (the top N
	// always sum to ~100%), which overstates concentration.
	const topHolders = h && Array.isArray(h.holders) ? h.holders.map(obj) : [];
	const supply = rawAmount(d.supply);
	const topAmount = topHolders.length > 0 ? rawAmount(topHolders[0].amount) : null;
	const topHolderPercent =
		supply !== null && topAmount !== null ? percentOf(topAmount, supply) : null;

	const q = new URLSearchParams({ mint });
	if (network === 'devnet') q.set('network', 'devnet');
	const viewerUrl = `${siteBase}/coin3d?${q.toString()}`;

	return {
		mint,
		network,
		name,
		symbol: symbol ? symbol.toUpperCase() : null,
		image,
		marketCapUsd: num(d.marketCapUsd ?? d.usdMarketCap ?? d.market_cap),
		graduated,
		graduationProgress,
		topHolderPercent,
		topHolders: topHolders.map((holder) => {
			const amount = rawAmount(holder.amount);
			return {
				...holder,
				percentOfSupply: supply !== null && amount !== null ? percentOf(amount, supply) : null,
			};
		}),
		viewerUrl,
		embedHtml: `<iframe src="${viewerUrl}" width="640" height="420" frameborder="0" allow="fullscreen" style="border:0;border-radius:16px"></iframe>`,
		rendering: {
			coin: image
				? 'token logo textured onto a spinning 3D medallion'
				: 'brand-tinted disc (no logo found)',
			holderGalaxy:
				topHolders.length > 0
					? `${topHolders.length} top holders as balance-sized, concentration-tinted orbiting spheres`
					: 'no holder data available',
			graduationRing: curveKnown
				? graduated
					? 'full ring (graduated to its PumpSwap pool)'
					: 'arc filled to bonding-curve progress'
				: 'no bonding-curve data available',
		},
	};
}

/** @type {{ def: Tool, handler: NativeHandler }[]} */
export const NATIVE_TOOLS = [
	{
		def: {
			name: 'pumpfun_token_3d',
			title: 'Token 3D Snapshot',
			annotations: {
				// Composes live on-chain reads (metadata, curve, holders) — a
				// read-only, non-idempotent, open-world tool like its sources.
				title: 'Token 3D Snapshot',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				'Live 3D snapshot of a pump.fun / Solana token. Composes on-chain token metadata, bonding-curve graduation progress, and top-holder distribution (each holder\'s share of total supply), and returns a shareable three.ws /coin3d viewer deep-link (a spinning coin medallion textured with the token logo, a holder galaxy, and a graduation ring) plus an embeddable iframe and the underlying data. Read-only, free. Use this to hand a user a visual, shareable view of a coin; for the raw numbers alone call get_token_details and get_token_holders.',
			inputSchema: {
				type: 'object',
				properties: {
					mint: {
						type: 'string',
						description: 'SPL / pump.fun token mint address (base58).',
						minLength: 32,
						maxLength: 44,
						pattern: '^[1-9A-HJ-NP-Za-km-z]+$',
					},
					network: { type: 'string', enum: ['mainnet', 'devnet'], default: 'mainnet' },
				},
				required: ['mint'],
			},
		},
		handler: token3dHandler,
	},
];

/**
 * @param {string} backendUrl
 * @param {CallBackendTool} call
 * @returns {{ defs: Tool[], handlers: Map<string, NativeEntry> }}
 */
export function buildNativeRegistry(backendUrl, call) {
	const siteBase = siteBaseFrom(backendUrl);
	const defs = NATIVE_TOOLS.map((t) => t.def);
	/** @type {Map<string, NativeEntry>} */
	const handlers = new Map();
	for (const t of NATIVE_TOOLS) {
		handlers.set(t.def.name, (args, signal) =>
			t.handler(args, { call: (name, a) => call(name, a, signal), siteBase, signal }),
		);
	}
	return { defs, handlers };
}
