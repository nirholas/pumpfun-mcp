// URL helpers shared by the bridge and the native tools.

/**
 * The origin of a URL, for logs and error text. A self-hosted backend URL can
 * carry credentials, an API key in the query string or a token in the path, and
 * error text reaches the model, so nothing past the origin is ever echoed.
 *
 * @param {string} raw
 * @returns {string}
 */
export function redactUrl(raw) {
	try {
		const { origin } = new URL(raw);
		return origin === 'null' ? '<non-http URL>' : origin;
	} catch {
		return '<invalid URL>';
	}
}

// ── Untrusted URL fetching ───────────────────────────────────────────────────
// A token's metadata `uri` and `image` are chosen by whoever created the token.
// Fetching them from the user's machine must not become a way to reach that
// machine's network: only public HTTPS hosts on the default port are allowed,
// redirects are re-checked hop by hop, and the body is size-capped.

export const DEFAULT_IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
const ARWEAVE_GATEWAY = 'https://arweave.net/';

// Public IPFS gateways that no longer serve content: ipfs.io and dweb.link
// switched to service-worker-only on 2026-09-21 and answer 429, w3s.link and
// nftstorage.link redirect to them, and cloudflare-ipfs.com / cf-ipfs.com shut
// down in 2024. Most pump.fun metadata (and the images inside it) still points
// at ipfs.io. IPFS content is addressed by CID, so re-pointing such a URL at a
// working gateway returns byte-identical content.
const RETIRED_IPFS_GATEWAYS = [
	'ipfs.io',
	'dweb.link',
	'w3s.link',
	'nftstorage.link',
	'cloudflare-ipfs.com',
	'cf-ipfs.com',
];
const MAX_REDIRECTS = 3;
export const MAX_METADATA_BYTES = 256 * 1024;

// Hostname suffixes that only resolve inside private networks.
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet'];

/**
 * True for an https: URL on the default port whose host is a public DNS name.
 * IP-literal hosts are refused outright (legitimate metadata hosts are named),
 * as are single-label and private-only names such as `localhost` or `nas.local`.
 *
 * @param {URL} url
 * @returns {boolean}
 */
export function isPublicHttpsUrl(url) {
	if (url.protocol !== 'https:') return false;
	if (url.port !== '' || url.username !== '' || url.password !== '') return false;
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
	if (!host.includes('.') || host === 'localhost') return false;
	return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * The IPFS path gateway (ending in `/ipfs/`) used for `ipfs://` references and
 * retired-gateway URLs: PUMPFUN_IPFS_GATEWAY when it is a public https URL,
 * otherwise DEFAULT_IPFS_GATEWAY.
 *
 * @returns {string}
 */
export function ipfsGateway() {
	const configured = process.env.PUMPFUN_IPFS_GATEWAY;
	if (configured) {
		try {
			const url = new URL(configured);
			if (isPublicHttpsUrl(url)) {
				const base = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
				return base.endsWith('/ipfs') ? `${base}/` : `${base}/ipfs/`;
			}
		} catch {
			// fall through to the default
		}
	}
	return DEFAULT_IPFS_GATEWAY;
}

/**
 * If `url` is served by a retired public gateway, the same CID path on the
 * working gateway; otherwise `url` unchanged. Handles path-style
 * (`https://ipfs.io/ipfs/<cid>/x`) and subdomain-style
 * (`https://<cid>.ipfs.dweb.link/x`) gateway URLs.
 *
 * @param {URL} url
 * @returns {URL}
 */
function repointRetiredGateway(url) {
	const host = url.hostname.toLowerCase();
	const tail = `${url.search}${url.hash}`;
	if (RETIRED_IPFS_GATEWAYS.includes(host) && url.pathname.startsWith('/ipfs/')) {
		return new URL(ipfsGateway() + url.pathname.slice('/ipfs/'.length) + tail);
	}
	const sub = host.match(/^([a-z0-9]+)\.ipfs\.(.+)$/);
	if (sub && RETIRED_IPFS_GATEWAYS.includes(sub[2])) {
		return new URL(ipfsGateway() + sub[1] + url.pathname + tail);
	}
	return url;
}

/**
 * Map a token media/metadata reference to a public HTTPS URL: `ipfs://` and
 * `ar://` go through a public gateway, `https://` must pass isPublicHttpsUrl,
 * and retired IPFS gateways are re-pointed at a working one. Anything else
 * (http:, data:, javascript:, private hosts) yields null.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function toPublicHttpsUrl(raw) {
	if (typeof raw !== 'string') return null;
	const value = raw.trim();
	let candidate = value;
	if (value.startsWith('ipfs://')) candidate = ipfsGateway() + value.slice(7).replace(/^ipfs\//, '');
	else if (value.startsWith('ar://')) candidate = ARWEAVE_GATEWAY + value.slice(5);
	let url;
	try {
		url = new URL(candidate);
	} catch {
		return null;
	}
	if (!isPublicHttpsUrl(url)) return null;
	return repointRetiredGateway(url).href;
}

/**
 * Read a response body as text, refusing anything over `maxBytes`.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @returns {Promise<string | null>} null when the body is too large
 */
async function readCapped(res, maxBytes) {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	if (!res.body) return '';
	const reader = res.body.getReader();
	/** @type {Uint8Array[]} */
	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET an untrusted URL and parse it as JSON, or resolve null. Never throws for
 * a bad URL, a refused host, a redirect to a refused host, a non-2xx status, an
 * oversized body or invalid JSON: the caller treats all of them as "no data".
 * Aborts (timeout or client cancellation) propagate through `signal`.
 *
 * @param {unknown} raw
 * @param {{ signal?: AbortSignal, maxBytes?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function fetchPublicJson(raw, { signal, maxBytes = MAX_METADATA_BYTES } = {}) {
	let target = toPublicHttpsUrl(raw);
	for (let hop = 0; target !== null && hop <= MAX_REDIRECTS; hop++) {
		const res = await fetch(target, {
			redirect: 'manual',
			headers: { accept: 'application/json' },
			signal,
		});
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get('location');
			await res.body?.cancel();
			if (!location) return null;
			let next;
			try {
				next = new URL(location, target);
			} catch {
				return null;
			}
			target = isPublicHttpsUrl(next) ? next.href : null;
			continue;
		}
		if (!res.ok) {
			await res.body?.cancel();
			return null;
		}
		const text = await readCapped(res, maxBytes);
		if (text === null) return null;
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}
	return null;
}
