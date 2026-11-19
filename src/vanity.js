// Local vanity keypair grinding for pumpfun_vanity_mint.
//
// The keypair is generated in this process with node:crypto (Ed25519, the
// Solana key type). The secret key exists only in the tool result returned to
// the MCP client: it is never sent to the backend, logged, or stored.

import { generateKeyPairSync } from 'node:crypto';

import { BASE58_ALPHABET, encodeBase58 } from './base58.js';
import { INVALID_PARAMS, NO_DATA, ToolError } from './errors.js';

export const VANITY_TIME_LIMIT_MS = 60_000;
export const VANITY_DEFAULT_MAX_ATTEMPTS = 5_000_000;
export const VANITY_MAX_ATTEMPTS = 50_000_000;
// Each extra base58 character multiplies the expected work by up to 58; past
// this many characters no search finishes inside the time limit.
export const VANITY_MAX_PATTERN_LENGTH = 8;

// Attempts between yields to the event loop, so stdio (and cancellation)
// stay responsive during a long search.
const BATCH = 256;

/**
 * Pattern options arrive straight from tool arguments, so they are typed
 * `unknown` and validated here.
 *
 * @typedef {object} VanityOptions
 * @property {unknown} [prefix]
 * @property {unknown} [suffix]
 * @property {unknown} [caseSensitive]
 * @property {unknown} [maxAttempts]
 * @property {number} [timeLimitMs]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} VanityResult
 * @property {string} publicKey Base58 address.
 * @property {string} secretKey Base58 of the 64-byte Solana secret key (seed || public key).
 * @property {number} attempts
 * @property {number} durationMs
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} caseSensitive
 * @returns {string}
 */
function checkPattern(value, field, caseSensitive) {
	if (value === undefined || value === null || value === '') return '';
	if (typeof value !== 'string') throw new ToolError(`${field} must be a string`, INVALID_PARAMS);
	for (const ch of value) {
		const ok = caseSensitive
			? BASE58_ALPHABET.includes(ch)
			: BASE58_ALPHABET.includes(ch.toUpperCase()) || BASE58_ALPHABET.includes(ch.toLowerCase());
		if (!ok) {
			throw new ToolError(
				`${field} contains "${ch}", which never appears in a base58 address (0, O, I and l are excluded)`,
				INVALID_PARAMS,
			);
		}
	}
	return value;
}

/**
 * Grind Ed25519 keypairs until the base58 address matches the prefix and/or
 * suffix, the attempt budget runs out, the time limit passes, or `signal`
 * aborts.
 *
 * @param {VanityOptions} options
 * @returns {Promise<VanityResult>}
 */
export async function grindVanityKeypair({
	prefix: rawPrefix,
	suffix: rawSuffix,
	caseSensitive = false,
	maxAttempts = VANITY_DEFAULT_MAX_ATTEMPTS,
	timeLimitMs = VANITY_TIME_LIMIT_MS,
	signal,
}) {
	if (typeof caseSensitive !== 'boolean') {
		throw new ToolError('caseSensitive must be a boolean', INVALID_PARAMS);
	}
	const prefix = checkPattern(rawPrefix, 'prefix', caseSensitive);
	const suffix = checkPattern(rawSuffix, 'suffix', caseSensitive);
	if (!prefix && !suffix) {
		throw new ToolError('provide a prefix, a suffix, or both', INVALID_PARAMS);
	}
	if (prefix.length + suffix.length > VANITY_MAX_PATTERN_LENGTH) {
		throw new ToolError(
			`prefix and suffix together may be at most ${VANITY_MAX_PATTERN_LENGTH} characters`,
			INVALID_PARAMS,
		);
	}
	if (
		typeof maxAttempts !== 'number' ||
		!Number.isInteger(maxAttempts) ||
		maxAttempts < 1 ||
		maxAttempts > VANITY_MAX_ATTEMPTS
	) {
		throw new ToolError(
			`maxAttempts must be an integer from 1 to ${VANITY_MAX_ATTEMPTS}`,
			INVALID_PARAMS,
		);
	}

	const wantPrefix = caseSensitive ? prefix : prefix.toLowerCase();
	const wantSuffix = caseSensitive ? suffix : suffix.toLowerCase();
	const started = performance.now();
	let attempts = 0;

	while (attempts < maxAttempts) {
		const batchEnd = Math.min(attempts + BATCH, maxAttempts);
		while (attempts < batchEnd) {
			attempts++;
			const { publicKey, privateKey } = generateKeyPairSync('ed25519');
			const pub = Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url');
			const address = encodeBase58(pub);
			const probe = caseSensitive ? address : address.toLowerCase();
			if (probe.startsWith(wantPrefix) && probe.endsWith(wantSuffix)) {
				const seed = Buffer.from(String(privateKey.export({ format: 'jwk' }).d), 'base64url');
				return {
					publicKey: address,
					secretKey: encodeBase58(Buffer.concat([seed, pub])),
					attempts,
					durationMs: Math.round(performance.now() - started),
				};
			}
		}
		if (signal?.aborted) throw new ToolError('vanity search cancelled', NO_DATA);
		if (performance.now() - started > timeLimitMs) {
			throw new ToolError(
				`no address matched within ${timeLimitMs / 1000} s (${attempts} attempts); try a shorter pattern`,
				NO_DATA,
			);
		}
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new ToolError(
		`no address matched within ${maxAttempts} attempts; try a shorter pattern or raise maxAttempts`,
		NO_DATA,
	);
}
