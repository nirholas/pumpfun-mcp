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
