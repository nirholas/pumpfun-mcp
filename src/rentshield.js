// Read-only Solana Rent & Rug Shield native tools (11-layer pre-buy rug check
// and 0%-first-claim empty ATA wallet rent scanner).

/** @typedef {import('@modelcontextprotocol/sdk/types.js').Tool} Tool */
/** @typedef {Record<string, unknown>} Json */
/** @typedef {(args: Record<string, unknown>) => Promise<Json>} RentShieldHandler */

const INVALID_PARAMS_CODE = -32602;
const NO_DATA_CODE = -32004;
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_RENTSHIELD_ORIGIN = 'https://rentandrugshield.com';

class RentShieldError extends Error {
	/**
	 * @param {string} message
	 * @param {number} rpcCode
	 */
	constructor(message, rpcCode) {
		super(message);
		this.name = 'ToolError';
		this.rpcCode = rpcCode;
	}
}

/** @type {typeof RentShieldError | null} */
let cachedErrorClass = null;

/** @returns {Promise<typeof RentShieldError>} */
async function getErrorClass() {
	if (cachedErrorClass) return cachedErrorClass;
	const errorsModulePath = './errors.js';
	try {
		const mod = /** @type {{ ToolError?: typeof RentShieldError }} */ (await import(errorsModulePath));
		cachedErrorClass = typeof mod.ToolError === 'function' ? mod.ToolError : RentShieldError;
	} catch {
		cachedErrorClass = RentShieldError;
	}
	return cachedErrorClass;
}

/** @type {{ url: string | null, expiresAt: number }} */
let cachedRentShieldBase = { url: null, expiresAt: 0 };

export function resetRentShieldCache() {
	cachedRentShieldBase = { url: null, expiresAt: 0 };
}

/**
 * @param {unknown} v
 * @returns {Json}
 */
function asObj(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Json} */ (v) : {};
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function asStr(v) {
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function asNum(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} raw
 * @param {string} fieldName
 * @returns {Promise<string>}
 */
async function assertPublicSolanaAddress(raw, fieldName) {
	const ErrorClass = await getErrorClass();
	const value = String(raw ?? '').trim();
	if (!value) {
		throw new ErrorClass(`${fieldName} is required`, INVALID_PARAMS_CODE);
	}
	if (!SOLANA_PUBKEY_RE.test(value)) {
		throw new ErrorClass(
			`invalid ${fieldName}: expected a public base58 Solana address (32-44 chars); never pass private keys or seed phrases`,
			INVALID_PARAMS_CODE,
		);
	}
	return value;
}

/** @returns {Promise<string | null>} */
async function resolveRentShieldLiveBase() {
	const now = Date.now();
	if (cachedRentShieldBase.url && cachedRentShieldBase.expiresAt > now) {
		return cachedRentShieldBase.url;
	}
	const res = await fetch(`${DEFAULT_RENTSHIELD_ORIGIN}/live_endpoint.json`, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(6000),
	});
	if (!res.ok) return null;
	const data = asObj(await res.json());
	const candidate = String(data.api_base || data.endpoint || '').trim().replace(/\/+$/, '');
	if (!candidate) return null;
	const parsed = new URL(candidate);
	if (parsed.protocol !== 'https:') return null;
	cachedRentShieldBase = { url: candidate, expiresAt: now + 5 * 60 * 1000 };
	return candidate;
}

/**
 * @param {string} pathname
 * @param {RequestInit} init
 * @returns {Promise<Json>}
 */
async function fetchRentShieldJson(pathname, init) {
	const envBase = String(process.env.RENTSHIELD_API_URL || '').trim().replace(/\/+$/, '');
	const initialBase =
		envBase ||
		(cachedRentShieldBase.url && cachedRentShieldBase.expiresAt > Date.now()
			? cachedRentShieldBase.url
			: DEFAULT_RENTSHIELD_ORIGIN);

	let res = await fetch(`${initialBase}${pathname}`, {
		...init,
		signal: AbortSignal.timeout(10000),
	});

	if (!envBase && (res.status === 404 || res.status === 405)) {
		const liveBase = await resolveRentShieldLiveBase();
		if (liveBase && liveBase !== initialBase) {
			res = await fetch(`${liveBase}${pathname}`, {
				...init,
				signal: AbortSignal.timeout(10000),
			});
		}
	}

	if (!res.ok) {
		const ErrorClass = await getErrorClass();
		throw new ErrorClass(`Rent & Rug Shield HTTP ${res.status}`, NO_DATA_CODE);
	}
	return asObj(await res.json());
}

/** @type {RentShieldHandler} */
async function rugShieldCheckHandler(args) {
	const mint = await assertPublicSolanaAddress(args?.mint, 'mint');
	const data = await fetchRentShieldJson(
		`/api/v1/shield-check?mint=${encodeURIComponent(mint)}`,
		{
			method: 'GET',
			headers: {
				Accept: 'application/json',
				'X-Payment-Protocol': 'x402',
			},
		},
	);
	const score = asNum(data.score ?? data.safety_score);
	return {
		mint: asStr(data.mint) || mint,
		symbol: asStr(data.symbol),
		name: asStr(data.name),
		tokenProgram: asStr(data.token_program),
		score,
		safeToBuy: Boolean(data.safe_to_buy ?? (score !== null && score >= 75 && !data.hidden_pda_rent_trap)),
		verdict: asStr(data.verdict),
		layersChecked: asNum(data.layers_checked) ?? 11,
		layersPassed: asNum(data.layers_passed),
		checklistSummary: asStr(data.checklist_summary),
		mintAuthorityActive: Boolean(data.mint_authority_active),
		freezeAuthorityActive: Boolean(data.freeze_authority_active),
		hasPermanentDelegate: Boolean(data.has_permanent_delegate),
		hasTransferHook: Boolean(data.has_transfer_hook),
		hiddenPdaRentTrap: Boolean(data.hidden_pda_rent_trap),
		checks: Array.isArray(data.checks) ? data.checks : [],
		reportUrl: `${DEFAULT_RENTSHIELD_ORIGIN}/audit/${mint}`,
	};
}

/** @type {RentShieldHandler} */
async function walletRentCheckHandler(args) {
	const wallet = await assertPublicSolanaAddress(args?.wallet, 'wallet');
	const data = await fetchRentShieldJson('/api/scan-wallet', {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ wallet, user_initiated: false }),
	});
	return {
		wallet: asStr(data.wallet) || wallet,
		isFirstFreeClaim: Boolean(data.is_first_free_claim),
		effectiveFeeBps: asNum(data.effective_fee_bps ?? data.fee_bps) ?? 0,
		reclaimableCount: asNum(data.reclaimable_count) ?? 0,
		emptyCount: asNum(data.empty_count) ?? 0,
		dustCount: asNum(data.dust_count) ?? 0,
		activeCount: asNum(data.active_count) ?? 0,
		totalReclaimableSol: asNum(data.total_reclaimable_sol) ?? 0,
		totalReclaimableLamports: asNum(data.total_reclaimable_lamports) ?? 0,
		emptyReclaimable: Array.isArray(data.empty_reclaimable) ? data.empty_reclaimable : [],
		dustReclaimable: Array.isArray(data.dust_reclaimable) ? data.dust_reclaimable : [],
		claimUrl: `${DEFAULT_RENTSHIELD_ORIGIN}/?wallet=${wallet}`,
	};
}

/** @type {{ def: Tool, handler: RentShieldHandler }[]} */
export const RENTSHIELD_TOOLS = [
	{
		def: {
			name: 'pumpfun_rug_shield_check',
			title: '11-Layer Pre-Buy Rug Shield',
			annotations: {
				title: '11-Layer Pre-Buy Rug Shield',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				'Read-only 11-layer pre-buy rug and scam safety check for a pump.fun, SPL, or Token-2022 mint via Solana Rent & Rug Shield (https://rentandrugshield.com). Evaluates mint/freeze authorities, Token-2022 permanent delegate & transfer hook traps, LP lock/burn status, holder concentration, and Block-0 Sybil clusters. Accepts only a public base58 mint address; never pass private keys or seed phrases.',
			inputSchema: {
				type: 'object',
				properties: {
					mint: {
						type: 'string',
						description: 'Public SPL / Token-2022 / pump.fun token mint address (base58).',
					},
				},
				required: ['mint'],
			},
		},
		handler: rugShieldCheckHandler,
	},
	{
		def: {
			name: 'solana_wallet_rent_check',
			title: '0% First-Claim Wallet Rent Check',
			annotations: {
				title: '0% First-Claim Wallet Rent Check',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				'Read-only, non-custodial Solana wallet scanner that previews reclaimable rent-exempt SOL locked in empty SPL and Token-2022 Associated Token Accounts (0% fee on first claim via https://rentandrugshield.com). Accepts only a public base58 wallet address; never pass private keys or seed phrases.',
			inputSchema: {
				type: 'object',
				properties: {
					wallet: {
						type: 'string',
						description: 'Public Solana wallet address (base58). Never pass a private key.',
					},
				},
				required: ['wallet'],
			},
		},
		handler: walletRentCheckHandler,
	},
];
