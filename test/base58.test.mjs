// Base58 codec and Solana address validation, checked against known vectors.
//
// Run: node --test test/base58.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { decodeBase58, encodeBase58, isSolanaAddress } from '../src/base58.js';

const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

test('known vectors encode and decode', () => {
	const vectors = [
		['', ''],
		['00', '1'],
		['0000', '11'],
		['61', '2g'],
		['626262', 'a3gV'],
		['636363', 'aPEr'],
		['00000000000000000000000000000000000000000000000000000000000000000000', '1111111111111111111111111111111111'],
		// The System Program id is 32 zero bytes.
		['0000000000000000000000000000000000000000000000000000000000000000', '11111111111111111111111111111111'],
		// wSOL mint So11111111111111111111111111111111111111112.
		['069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001', 'So11111111111111111111111111111111111111112'],
	];
	for (const [h, b58] of vectors) {
		assert.equal(encodeBase58(hex(h)), b58, `encode ${h}`);
		assert.deepEqual(decodeBase58(b58), hex(h), `decode ${b58}`);
	}
});

test('random byte strings round-trip, leading zeros included', () => {
	for (let i = 0; i < 200; i++) {
		const bytes = randomBytes(i % 70);
		if (i % 5 === 0 && bytes.length > 2) bytes[0] = bytes[1] = 0;
		assert.deepEqual(decodeBase58(encodeBase58(bytes)), Uint8Array.from(bytes));
	}
});

test('characters outside the alphabet are rejected', () => {
	for (const bad of ['0', 'O', 'I', 'l', '+', '/', ' ', 'é', 'abc0']) {
		assert.equal(decodeBase58(bad), null, bad);
	}
});

test('isSolanaAddress accepts 32-byte keys and nothing else', () => {
	assert.ok(isSolanaAddress('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'));
	assert.ok(isSolanaAddress('So11111111111111111111111111111111111111112'));
	assert.ok(isSolanaAddress('11111111111111111111111111111111'));
	for (const bad of [
		undefined,
		42,
		'',
		'notamint',
		'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpum0', // '0' is not base58
		'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpumpp', // 45 chars
		'1111111111111111111111111111111111', // 34 zero bytes
		'../../etc/passwd',
	]) {
		assert.equal(isSolanaAddress(bad), false, String(bad));
	}
});
