// Local vanity keypair grinding: the returned secret key must really control
// the returned address, patterns must be validated, and every limit (attempts,
// time, cancellation) must end the search.
//
// Run: node --test test/vanity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { decodeBase58 } from '../src/base58.js';
import { grindVanityKeypair } from '../src/vanity.js';

// DER prefixes that wrap a raw 32-byte Ed25519 seed / public key.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function assertKeypairControlsAddress({ publicKey, secretKey }) {
	const secret = decodeBase58(secretKey);
	const pub = decodeBase58(publicKey);
	assert.equal(secret.length, 64, 'Solana secret keys are seed (32) || public key (32)');
	assert.equal(pub.length, 32);
	assert.deepEqual(secret.subarray(32), pub, 'second half of the secret key is the address');

	const privateKey = createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519, secret.subarray(0, 32)]),
		format: 'der',
		type: 'pkcs8',
	});
	const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12);
	assert.deepEqual(Uint8Array.from(derived), pub, 'the seed derives the advertised address');

	const message = Buffer.from('pumpfun-mcp vanity self-test');
	const signature = sign(null, message, privateKey);
	const verifier = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub]), format: 'der', type: 'spki' });
	assert.ok(verify(null, message, verifier, signature), 'signature verifies against the address');
}

test('a one-character suffix is found and the keypair is genuine', async () => {
	const out = await grindVanityKeypair({ suffix: 'z' });
	assert.ok(out.publicKey.toLowerCase().endsWith('z'));
	assert.ok(out.attempts >= 1);
	assert.equal(typeof out.durationMs, 'number');
	assertKeypairControlsAddress(out);
});

test('a case-sensitive prefix matches exactly', async () => {
	const out = await grindVanityKeypair({ prefix: 'A', caseSensitive: true });
	assert.ok(out.publicKey.startsWith('A'));
	assertKeypairControlsAddress(out);
});

test('prefix and suffix together are both honoured', async () => {
	const out = await grindVanityKeypair({ prefix: 'a', suffix: 'b' });
	assert.ok(out.publicKey.toLowerCase().startsWith('a'));
	assert.ok(out.publicKey.toLowerCase().endsWith('b'));
});

test('patterns that can never match a base58 address are rejected up front', async () => {
	const cases = [
		[{ suffix: '0' }, /never appears in a base58 address/],
		[{ prefix: 'O', caseSensitive: true }, /never appears/],
		[{ prefix: 'l', caseSensitive: true }, /never appears/],
		[{ suffix: 'pump!' }, /never appears/],
		[{}, /prefix, a suffix, or both/],
		[{ prefix: '', suffix: '' }, /prefix, a suffix, or both/],
		[{ suffix: 123 }, /suffix must be a string/],
		[{ prefix: 'abcde', suffix: 'fghij' }, /at most 8 characters/],
		[{ suffix: 'a', caseSensitive: 'yes' }, /caseSensitive must be a boolean/],
		[{ suffix: 'a', maxAttempts: 0 }, /maxAttempts must be an integer/],
		[{ suffix: 'a', maxAttempts: 1.5 }, /maxAttempts must be an integer/],
		[{ suffix: 'a', maxAttempts: '10' }, /maxAttempts must be an integer/],
		[{ suffix: 'a', maxAttempts: 1e12 }, /maxAttempts must be an integer/],
	];
	for (const [opts, pattern] of cases) {
		await assert.rejects(grindVanityKeypair(opts), (err) => {
			assert.equal(err.rpcCode, -32602, JSON.stringify(opts));
			assert.match(err.message, pattern);
			return true;
		});
	}
});

test('case-insensitive patterns accept letters whose other case is base58', async () => {
	// 'l' and 'I' are not in the alphabet, but 'L' and 'i' are.
	const out = await grindVanityKeypair({ suffix: 'l' });
	assert.ok(out.publicKey.endsWith('L'));
});

test('the attempt budget ends a search that cannot finish', async () => {
	await assert.rejects(grindVanityKeypair({ suffix: 'zzzzzzzz', maxAttempts: 50 }), (err) => {
		assert.equal(err.rpcCode, -32004);
		assert.match(err.message, /within 50 attempts/);
		return true;
	});
});

test('the time limit ends a search that cannot finish', async () => {
	await assert.rejects(grindVanityKeypair({ suffix: 'zzzzzzzz', timeLimitMs: 1 }), (err) => {
		assert.equal(err.rpcCode, -32004);
		assert.match(err.message, /no address matched within/);
		return true;
	});
});

test('cancellation ends the search at the next batch boundary', async () => {
	const controller = new AbortController();
	const search = grindVanityKeypair({ suffix: 'zzzzzzzz', signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(search, /cancelled/);
});
