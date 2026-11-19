// The guard for creator-controlled URLs (token metadata uri and image), plus
// the redaction helper. fetch is stubbed; nothing here touches the network.
//
// Run: node --test test/url.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	DEFAULT_IPFS_GATEWAY,
	MAX_METADATA_BYTES,
	fetchPublicJson,
	ipfsGateway,
	isPublicHttpsUrl,
	scrubUrls,
	toPublicHttpsUrl,
} from '../src/url.js';

function withGateway(value, fn) {
	const prior = process.env.PUMPFUN_IPFS_GATEWAY;
	if (value === undefined) delete process.env.PUMPFUN_IPFS_GATEWAY;
	else process.env.PUMPFUN_IPFS_GATEWAY = value;
	try {
		return fn();
	} finally {
		if (prior === undefined) delete process.env.PUMPFUN_IPFS_GATEWAY;
		else process.env.PUMPFUN_IPFS_GATEWAY = prior;
	}
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

const json = (body, init = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
		...init,
	});

test('public https hosts on the default port are allowed', () => {
	for (const ok of [
		'https://ipfs.io/ipfs/Qm/meta.json',
		'https://pump.mypinata.cloud/ipfs/bafy',
		'https://arweave.net/abc',
		'https://example.com:443/x', // :443 normalizes to the default port
	]) {
		assert.equal(isPublicHttpsUrl(new URL(ok)), true, ok);
	}
});

test('private, local, IP-literal, non-default-port and non-https URLs are refused', () => {
	for (const bad of [
		'http://ipfs.io/ipfs/Qm',
		'https://localhost/x',
		'https://api.localhost/x',
		'https://nas.local/x',
		'https://metadata.google.internal/computeMetadata/v1/',
		'https://router.home.arpa/',
		'https://intranet/x',
		'https://127.0.0.1/x',
		'https://2130706433/x', // decimal 127.0.0.1
		'https://0x7f.1/x', // hex 127.0.0.1
		'https://169.254.169.254/latest/meta-data/',
		'https://10.0.0.1/x',
		'https://[::1]/x',
		'https://[::ffff:127.0.0.1]/x',
		'https://[fd00::1]/x',
		'https://example.com:8443/x',
		'https://user:pw@example.com/x',
		'file:///etc/passwd',
		'ftp://example.com/x',
	]) {
		assert.equal(isPublicHttpsUrl(new URL(bad)), false, bad);
	}
});

test('toPublicHttpsUrl maps ipfs:// and ar:// to gateways and drops everything unsafe', () => {
	assert.equal(toPublicHttpsUrl('ipfs://QmHash/logo.png'), `${DEFAULT_IPFS_GATEWAY}QmHash/logo.png`);
	assert.equal(toPublicHttpsUrl('ipfs://ipfs/QmHash'), `${DEFAULT_IPFS_GATEWAY}QmHash`);
	assert.equal(toPublicHttpsUrl('ar://txid'), 'https://arweave.net/txid');
	assert.equal(toPublicHttpsUrl('  https://cdn.example/a.png '), 'https://cdn.example/a.png');
	for (const bad of [
		null,
		42,
		'',
		'not a url',
		'javascript:alert(1)',
		'data:image/png;base64,AAAA',
		'http://cdn.example/a.png',
		'https://127.0.0.1/a.png',
	]) {
		assert.equal(toPublicHttpsUrl(bad), null, String(bad));
	}
});

test('fetchPublicJson never calls fetch for a refused URL', async () => {
	const calls = [];
	await withFetch(
		async (u) => {
			calls.push(u);
			return json({});
		},
		async () => {
			for (const bad of ['http://169.254.169.254/', 'https://localhost:3000/', 'file:///etc/passwd']) {
				assert.equal(await fetchPublicJson(bad), null);
			}
		},
	);
	assert.deepEqual(calls, []);
});

test('fetchPublicJson follows a redirect to a public host', async () => {
	const calls = [];
	const stub = async (u, init) => {
		calls.push(String(u));
		assert.equal(init.redirect, 'manual', 'redirects must be followed by hand, not by fetch');
		if (String(u).startsWith('https://a.example')) {
			return new Response(null, { status: 302, headers: { location: 'https://b.example/meta.json' } });
		}
		return json({ image: 'ipfs://QmImg' });
	};
	const out = await withFetch(stub, () => fetchPublicJson('https://a.example/m'));
	assert.deepEqual(out, { image: 'ipfs://QmImg' });
	assert.deepEqual(calls, ['https://a.example/m', 'https://b.example/meta.json']);
});

test('fetchPublicJson refuses a redirect into a private network', async () => {
	const calls = [];
	const stub = async (u) => {
		calls.push(String(u));
		return new Response(null, {
			status: 301,
			headers: { location: 'http://169.254.169.254/latest/meta-data/iam' },
		});
	};
	assert.equal(await withFetch(stub, () => fetchPublicJson('https://evil.example/m')), null);
	assert.deepEqual(calls, ['https://evil.example/m']);
});

test('fetchPublicJson stops after a bounded number of redirects', async () => {
	let n = 0;
	const stub = async () => {
		n++;
		return new Response(null, { status: 302, headers: { location: `https://loop.example/${n}` } });
	};
	assert.equal(await withFetch(stub, () => fetchPublicJson('https://loop.example/0')), null);
	assert.equal(n, 4, 'the first request plus three redirects');
});

test('fetchPublicJson refuses oversized bodies, declared or streamed', async () => {
	const big = 'x'.repeat(MAX_METADATA_BYTES + 1);
	const declared = async () =>
		new Response('{}', { headers: { 'content-length': String(MAX_METADATA_BYTES + 1) } });
	assert.equal(await withFetch(declared, () => fetchPublicJson('https://a.example/m')), null);
	const streamed = async () => new Response(`{"image":"${big}"}`);
	assert.equal(await withFetch(streamed, () => fetchPublicJson('https://a.example/m')), null);
});

test('fetchPublicJson maps non-2xx and invalid JSON to null', async () => {
	assert.equal(
		await withFetch(async () => new Response('nope', { status: 500 }), () =>
			fetchPublicJson('https://a.example/m'),
		),
		null,
	);
	assert.equal(
		await withFetch(async () => new Response('<html>'), () => fetchPublicJson('https://a.example/m')),
		null,
	);
});

test('retired gateways are re-pointed by CID; live gateways and other paths are left alone', () => {
	withGateway(undefined, () => {
		const cases = [
			['https://ipfs.io/ipfs/bafyA/meta.json?x=1', `${DEFAULT_IPFS_GATEWAY}bafyA/meta.json?x=1`],
			['https://dweb.link/ipfs/bafyB', `${DEFAULT_IPFS_GATEWAY}bafyB`],
			['https://cloudflare-ipfs.com/ipfs/QmC', `${DEFAULT_IPFS_GATEWAY}QmC`],
			['https://bafyd.ipfs.dweb.link/img.png', `${DEFAULT_IPFS_GATEWAY}bafyd/img.png`],
			['https://bafye.ipfs.w3s.link/', `${DEFAULT_IPFS_GATEWAY}bafye/`],
			// Not a gateway path: untouched.
			['https://ipfs.io/docs', 'https://ipfs.io/docs'],
			// A live gateway: untouched.
			['https://pump.mypinata.cloud/ipfs/QmF', 'https://pump.mypinata.cloud/ipfs/QmF'],
		];
		for (const [input, expected] of cases) assert.equal(toPublicHttpsUrl(input), expected, input);
	});
});

test('PUMPFUN_IPFS_GATEWAY overrides the gateway only when it is a public https URL', () => {
	for (const [value, expected] of [
		[undefined, DEFAULT_IPFS_GATEWAY],
		['https://gw.example', 'https://gw.example/ipfs/'],
		['https://gw.example/', 'https://gw.example/ipfs/'],
		['https://gw.example/ipfs', 'https://gw.example/ipfs/'],
		['https://gw.example/ipfs/', 'https://gw.example/ipfs/'],
		['http://gw.example/ipfs/', DEFAULT_IPFS_GATEWAY],
		['https://127.0.0.1:8080/ipfs/', DEFAULT_IPFS_GATEWAY],
		['not a url', DEFAULT_IPFS_GATEWAY],
	]) {
		withGateway(value, () => assert.equal(ipfsGateway(), expected, String(value)));
	}
	withGateway('https://gw.example', () => {
		assert.equal(toPublicHttpsUrl('ipfs://QmX'), 'https://gw.example/ipfs/QmX');
		assert.equal(toPublicHttpsUrl('https://ipfs.io/ipfs/QmX'), 'https://gw.example/ipfs/QmX');
	});
});

test('scrubUrls reduces every embedded URL to its origin', () => {
	assert.equal(
		scrubUrls('holders unavailable: solana rpc 429 @ https://mainnet.helius-rpc.com/?api-key=sk-123'),
		'holders unavailable: solana rpc 429 @ https://mainnet.helius-rpc.com',
	);
	assert.equal(
		scrubUrls('a (https://u:p@x.example/k/abc) and "http://y.example:8899/t?k=1", done'),
		'a (https://x.example) and "http://y.example:8899", done',
	);
	assert.equal(scrubUrls('no urls here'), 'no urls here');
});
