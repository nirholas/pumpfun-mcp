import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildNativeRegistry, NATIVE_TOOLS, resetRentShieldCache } from '../src/native.js';

const BACKEND = 'https://three.ws/api/pump-fun-mcp';
const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const FAKE_SECRET_KEY = '5MaiiCavjCmn9Hs1o3eznqDEhRwxo7pXiAYez7keQUviUkauRiTMD8DrESdrNjN8zd9mTmVhRvBJeg5vhyvgrAhG';

function stubCall() {
	return async (name) => {
		throw new Error(`${name} unavailable`);
	};
}

async function withFetch(stub, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

const noFetch = () => {
	throw new Error('unexpected network call');
};

test('every native tool carries explicit read-only and non-destructive annotations', () => {
	for (const { def } of NATIVE_TOOLS) {
		assert.equal(def.annotations.readOnlyHint, true, `${def.name}: readOnlyHint`);
		assert.equal(def.annotations.destructiveHint, false, `${def.name}: destructiveHint`);
	}
});

test('pumpfun_rug_shield_check and solana_wallet_rent_check reject blank or secret-key inputs offline', async () => {
	const { handlers } = buildNativeRegistry(BACKEND, stubCall());
	const checkMint = handlers.get('pumpfun_rug_shield_check');
	const checkWallet = handlers.get('solana_wallet_rent_check');

	for (const bad of [{}, { mint: '' }, { mint: 'not-base58!' }, { mint: FAKE_SECRET_KEY }, { mint: 'word1 word2 word3' }]) {
		await withFetch(noFetch, async () => {
			await assert.rejects(checkMint(bad), (err) => {
				assert.equal(err.rpcCode, -32602);
				return true;
			});
		});
	}

	for (const bad of [{}, { wallet: '' }, { wallet: FAKE_SECRET_KEY }, { wallet: 'seed phrase words here' }]) {
		await withFetch(noFetch, async () => {
			await assert.rejects(checkWallet(bad), (err) => {
				assert.equal(err.rpcCode, -32602);
				return true;
			});
		});
	}
});

test('pumpfun_rug_shield_check parses 11-layer audit response and resolves live_endpoint.json on 404', async () => {
	resetRentShieldCache();
	const calls = [];
	const fetchStub = async (url) => {
		const u = String(url);
		calls.push(u);
		if (u.startsWith('https://rentandrugshield.com/api/v1/shield-check')) {
			return new Response('not found', { status: 404 });
		}
		if (u === 'https://rentandrugshield.com/live_endpoint.json') {
			return new Response(JSON.stringify({ ok: true, api_base: 'https://edge.rentandrugshield.example' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		return new Response(
			JSON.stringify({
				ok: true,
				mint: MINT,
				symbol: 'PUMP',
				name: 'Pump Token',
				token_program: 'SPL Token',
				score: 92,
				safe_to_buy: true,
				verdict: 'SAFE',
				layers_checked: 11,
				layers_passed: 11,
				checklist_summary: '11/11',
				checks: [{ layer: 1, key: 'mint_auth', passed: true }],
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	};

	const { handlers } = buildNativeRegistry(BACKEND, stubCall());
	const out = await withFetch(fetchStub, () => handlers.get('pumpfun_rug_shield_check')({ mint: MINT }));
	assert.equal(out.mint, MINT);
	assert.equal(out.score, 92);
	assert.equal(out.safeToBuy, true);
	assert.equal(out.layersChecked, 11);
	assert.equal(out.reportUrl, `https://rentandrugshield.com/audit/${MINT}`);
	assert.equal(calls.length, 3);
});

test('solana_wallet_rent_check posts public wallet only and maps 0%-first-claim preview', async () => {
	resetRentShieldCache();
	let postedBody = null;
	const fetchStub = async (_url, init) => {
		postedBody = JSON.parse(init.body);
		return new Response(
			JSON.stringify({
				ok: true,
				wallet: WALLET,
				is_first_free_claim: true,
				effective_fee_bps: 0,
				reclaimable_count: 4,
				empty_count: 4,
				dust_count: 0,
				active_count: 2,
				total_reclaimable_sol: 0.008157,
				total_reclaimable_lamports: 8157120,
				empty_reclaimable: [{ pubkey: WALLET, rent_sol: 0.002039 }],
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		);
	};

	const { handlers } = buildNativeRegistry(BACKEND, stubCall());
	const out = await withFetch(fetchStub, () => handlers.get('solana_wallet_rent_check')({ wallet: WALLET }));
	assert.deepEqual(postedBody, { wallet: WALLET, user_initiated: false });
	assert.equal(out.wallet, WALLET);
	assert.equal(out.isFirstFreeClaim, true);
	assert.equal(out.effectiveFeeBps, 0);
	assert.equal(out.emptyCount, 4);
	assert.equal(out.totalReclaimableSol, 0.008157);
});
