// End-to-end behavior of the stdio <-> HTTP bridge: an MCP client talks to the
// server built by buildServer() over an in-memory transport, and the backend is
// a stubbed globalThis.fetch. Nothing here touches the network.
//
// Run: node --test test/bridge.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../src/index.js';
import { redactUrl } from '../src/url.js';

const BACKEND = 'https://backend.test/api/pump-fun-mcp';

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
};

const BACKEND_TOOLS = [
	{
		name: 'get_bonding_curve',
		description: 'curve',
		inputSchema: { type: 'object', properties: { mint: { type: 'string' } } },
		annotations: READ_ONLY,
	},
	{
		name: 'get_token_holders',
		description: 'holders',
		inputSchema: { type: 'object', properties: { mint: { type: 'string' } } },
		annotations: READ_ONLY,
	},
];

/**
 * Build a fetch stub that answers JSON-RPC posts to BACKEND. `tools` is the
 * tools/list payload; `onCall(name, args, init)` answers tools/call with a full
 * JSON-RPC envelope (minus jsonrpc/id) or throws to simulate a transport error.
 */
function backendFetch({ tools = BACKEND_TOOLS, onCall, log = [] } = {}) {
	return async (url, init) => {
		assert.equal(String(url), process.env.PUMPFUN_MCP_URL);
		const body = JSON.parse(init.body);
		log.push(body);
		let envelope;
		if (body.method === 'tools/list') envelope = { result: { tools } };
		else if (body.method === 'tools/call') {
			envelope = await onCall(body.params.name, body.params.arguments, init);
		} else envelope = { error: { code: -32601, message: `no ${body.method}` } };
		return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...envelope }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
}

/** Run fn(client) against a freshly built server wired to the given fetch stub. */
async function withBridge(fetchStub, fn, { url = BACKEND } = {}) {
	const priorFetch = globalThis.fetch;
	const priorUrl = process.env.PUMPFUN_MCP_URL;
	process.env.PUMPFUN_MCP_URL = url;
	globalThis.fetch = fetchStub;
	const server = await buildServer();
	const client = new Client({ name: 'bridge-test', version: '0.0.0' });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	try {
		await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
		return await fn(client, server);
	} finally {
		await client.close();
		await server.close();
		globalThis.fetch = priorFetch;
		if (priorUrl === undefined) delete process.env.PUMPFUN_MCP_URL;
		else process.env.PUMPFUN_MCP_URL = priorUrl;
	}
}

test('a successful backend result passes through with its structuredContent', async () => {
	const fetchStub = backendFetch({
		onCall: async () => ({
			result: {
				content: [{ type: 'text', text: '{"complete":false}' }],
				structuredContent: { complete: false },
			},
		}),
	});
	await withBridge(fetchStub, async (client) => {
		const res = await client.callTool({ name: 'get_bonding_curve', arguments: { mint: 'm' } });
		assert.notEqual(res.isError, true);
		assert.deepEqual(res.structuredContent, { complete: false });
		assert.equal(res.content[0].text, '{"complete":false}');
	});
});

test('a backend isError result stays an error for the client', async () => {
	const fetchStub = backendFetch({
		onCall: async () => ({
			result: { isError: true, content: [{ type: 'text', text: 'RPC node timed out' }] },
		}),
	});
	await withBridge(fetchStub, async (client) => {
		const res = await client.callTool({ name: 'get_bonding_curve', arguments: { mint: 'm' } });
		assert.equal(res.isError, true);
		assert.equal(res.content[0].text, 'RPC node timed out');
	});
});

test('a JSON-RPC error envelope becomes an isError result carrying its code', async () => {
	const fetchStub = backendFetch({
		onCall: async () => ({ error: { code: -32602, message: 'invalid mint' } }),
	});
	await withBridge(fetchStub, async (client) => {
		const res = await client.callTool({ name: 'get_bonding_curve', arguments: { mint: 'x' } });
		assert.equal(res.isError, true);
		assert.equal(res.content[0].text, '[-32602] invalid mint');
	});
});

test('an HTTP failure from the backend surfaces as "Backend request failed"', async () => {
	const fetchStub = async (url, init) => {
		const body = JSON.parse(init.body);
		if (body.method === 'tools/list') return backendFetch()(url, init);
		return new Response('upstream down', { status: 502 });
	};
	await withBridge(fetchStub, async (client) => {
		const res = await client.callTool({ name: 'get_bonding_curve', arguments: { mint: 'm' } });
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /^Backend request failed: .*HTTP 502/);
	});
});

test('redactUrl keeps only the origin: no credentials, path, query or fragment', () => {
	assert.equal(
		redactUrl('https://user:hunter2@rpc.example.com:8443/v1/sk-live-123?api-key=abc#frag'),
		'https://rpc.example.com:8443',
	);
	assert.equal(redactUrl('not a url'), '<invalid URL>');
	assert.equal(redactUrl('file:///etc/passwd'), '<non-http URL>');
});

test('backend failures never echo a secret-bearing PUMPFUN_MCP_URL', async () => {
	const url = 'https://user:hunter2@self.example/v1/sk-live-123/mcp?api-key=abc';
	const fetchStub = async (u, init) => {
		const body = JSON.parse(init.body);
		if (body.method === 'tools/list') return backendFetch()(u, init);
		return new Response('nope', { status: 500 });
	};
	await withBridge(
		fetchStub,
		async (client) => {
			const res = await client.callTool({ name: 'get_bonding_curve', arguments: { mint: 'm' } });
			assert.equal(res.isError, true);
			const text = res.content[0].text;
			assert.match(text, /https:\/\/self\.example answered HTTP 500/);
			for (const secret of ['hunter2', 'sk-live-123', 'api-key', 'abc']) {
				assert.ok(!text.includes(secret), `error text leaked ${secret}: ${text}`);
			}
		},
		{ url },
	);
});

test('a non-http PUMPFUN_MCP_URL is refused before anything is sent', async () => {
	const log = [];
	const fetchStub = async () => {
		log.push('called');
		throw new Error('fetch must not be called');
	};
	await withBridge(
		fetchStub,
		async (client) => {
			const res = await client.callTool({ name: 'get_bonding_curve', arguments: { mint: 'm' } });
			assert.equal(res.isError, true);
			assert.match(res.content[0].text, /PUMPFUN_MCP_URL must be an http\(s\) URL/);
		},
		{ url: 'file:///etc/passwd' },
	);
	assert.deepEqual(log, []);
});

test('client cancellation aborts the in-flight backend fetch', async () => {
	let sawAbort;
	const aborted = new Promise((resolve) => {
		sawAbort = resolve;
	});
	const fetchStub = async (url, init) => {
		const body = JSON.parse(init.body);
		if (body.method === 'tools/list') return backendFetch()(url, init);
		// Hang until the bridge aborts the request, like a stalled backend.
		return new Promise((_, reject) => {
			init.signal.addEventListener('abort', () => {
				sawAbort(true);
				reject(init.signal.reason);
			});
		});
	};
	await withBridge(fetchStub, async (client) => {
		const controller = new AbortController();
		const call = client.callTool(
			{ name: 'get_bonding_curve', arguments: { mint: 'm' } },
			undefined,
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 20);
		await assert.rejects(call);
		assert.equal(await aborted, true);
	});
});

test('backend tools not annotated read-only are neither listed nor callable', async () => {
	const log = [];
	const tools = [
		...BACKEND_TOOLS,
		{
			name: 'pumpfun_upload_metadata',
			description: 'writes to IPFS',
			inputSchema: { type: 'object', properties: {} },
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		// Unknown to the local overlay and shipped without annotations.
		{ name: 'mystery_tool', description: '?', inputSchema: { type: 'object', properties: {} } },
	];
	const fetchStub = backendFetch({
		tools,
		log,
		onCall: async () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }),
	});
	await withBridge(fetchStub, async (client) => {
		const { tools: listed } = await client.listTools();
		const names = listed.map((t) => t.name);
		assert.ok(names.includes('get_bonding_curve'));
		assert.ok(!names.includes('pumpfun_upload_metadata'), 'write tool must not be listed');
		assert.ok(!names.includes('mystery_tool'), 'unannotated tool must not be listed');
		for (const t of listed) assert.equal(t.annotations?.readOnlyHint, true, t.name);

		for (const name of ['pumpfun_upload_metadata', 'mystery_tool', 'no_such_tool', '__proto__']) {
			await assert.rejects(client.callTool({ name, arguments: {} }), (err) => {
				assert.equal(err.code, -32602);
				assert.match(err.message, /Unknown tool/);
				return true;
			});
		}
	});
	assert.deepEqual(
		log.filter((b) => b.method === 'tools/call'),
		[],
		'refused tools never reach the backend',
	);
});

test('a legacy camelCase alias of an advertised tool is still forwarded', async () => {
	const log = [];
	const fetchStub = backendFetch({
		log,
		onCall: async (name) => ({ result: { content: [{ type: 'text', text: name }] } }),
	});
	await withBridge(fetchStub, async (client) => {
		const res = await client.callTool({ name: 'getBondingCurve', arguments: { mint: 'm' } });
		assert.notEqual(res.isError, true);
		assert.equal(res.content[0].text, 'getBondingCurve');
	});
	assert.equal(log.filter((b) => b.method === 'tools/call').length, 1);
});

test('backend tools missing annotations get the local read-only overlay', async () => {
	const bare = BACKEND_TOOLS.map(({ annotations: _annotations, ...rest }) => rest);
	await withBridge(backendFetch({ tools: bare, onCall: async () => ({ result: {} }) }), async (client) => {
		const { tools } = await client.listTools();
		const curve = tools.find((t) => t.name === 'get_bonding_curve');
		assert.equal(curve.title, 'Bonding Curve');
		assert.equal(curve.annotations.readOnlyHint, true);
	});
});

test('pumpfun_vanity_mint runs locally: listed once, never sent to the backend', async () => {
	const log = [];
	const tools = [
		...BACKEND_TOOLS,
		{
			name: 'pumpfun_vanity_mint',
			description: 'remote grind',
			inputSchema: { type: 'object', properties: {} },
			annotations: { ...READ_ONLY, openWorldHint: false },
		},
	];
	const fetchStub = backendFetch({
		tools,
		log,
		onCall: async () => {
			throw new Error('vanity must not reach the backend');
		},
	});
	await withBridge(fetchStub, async (client) => {
		const { tools: listed } = await client.listTools();
		const vanity = listed.filter((t) => t.name === 'pumpfun_vanity_mint');
		assert.equal(vanity.length, 1);
		assert.match(vanity[0].description, /never sent to any server/);

		const res = await client.callTool({ name: 'pumpfun_vanity_mint', arguments: { suffix: 'x' } });
		assert.notEqual(res.isError, true);
		assert.ok(res.structuredContent.publicKey.toLowerCase().endsWith('x'));
		assert.equal(res.structuredContent.generatedLocally, true);

		const bad = await client.callTool({ name: 'pumpfun_vanity_mint', arguments: { suffix: '0' } });
		assert.equal(bad.isError, true);
		assert.match(bad.content[0].text, /^\[-32602\]/);
	});
	assert.deepEqual(log.filter((b) => b.method === 'tools/call'), []);
});
