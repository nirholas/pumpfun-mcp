// Base58 (Bitcoin alphabet), the encoding of Solana addresses and keys.

export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** @type {Int8Array} char code -> digit value, -1 for characters outside the alphabet */
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE58_ALPHABET.length; i++) DIGIT[BASE58_ALPHABET.charCodeAt(i)] = i;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeBase58(bytes) {
	let zeros = 0;
	while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
	/** @type {number[]} base-58 digits, least significant first */
	const digits = [];
	for (let i = zeros; i < bytes.length; i++) {
		let carry = bytes[i];
		for (let j = 0; j < digits.length; j++) {
			carry += digits[j] << 8;
			digits[j] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry > 0) {
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let out = '1'.repeat(zeros);
	for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
	return out;
}

/**
 * @param {string} text
 * @returns {Uint8Array | null} null when `text` contains a non-base58 character
 */
export function decodeBase58(text) {
	let zeros = 0;
	while (zeros < text.length && text[zeros] === '1') zeros++;
	/** @type {number[]} bytes, least significant first */
	const bytes = [];
	for (let i = zeros; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const value = code < 128 ? DIGIT[code] : -1;
		if (value < 0) return null;
		let carry = value;
		for (let j = 0; j < bytes.length; j++) {
			carry += bytes[j] * 58;
			bytes[j] = carry & 0xff;
			carry >>= 8;
		}
		while (carry > 0) {
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	const out = new Uint8Array(zeros + bytes.length);
	for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
	return out;
}

/**
 * True when `value` is a base58 string that decodes to exactly 32 bytes, the
 * shape of every Solana public key (wallets, mints, program accounts).
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSolanaAddress(value) {
	if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
	return decodeBase58(value)?.length === 32;
}
