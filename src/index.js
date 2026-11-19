#!/usr/bin/env node
// @three-ws/pumpfun-mcp — stdio MCP server for pump.fun + Solana read-only data.
//
// A zero-config, free MCP server. It exposes pump.fun token discovery, on-chain
// bonding-curve / holder analysis, creator fee-claim tracking, SNS name
// resolution, KOL radar/leaderboard signals, and read-only swap quotes.
//
// Architecture: this process is a thin stdio <-> HTTP bridge in front of the
// canonical three.ws pump.fun MCP backend (https://three.ws/api/pump-fun-mcp).
// The backend is the single source of truth — it performs every Solana RPC and
// pump.fun API call server-side, so clients need no RPC URL, no API keys, and
// no secrets. All data is live and on-chain; there is no mock or sample path.
//
// Override the backend with PUMPFUN_MCP_URL (e.g. to self-host the handler).
//
// Run standalone:    npx @three-ws/pumpfun-mcp
// Inspect:           npx -y @modelcontextprotocol/inspector npx @three-ws/pumpfun-mcp

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { FALLBACK_TOOLS, TOOL_ANNOTATIONS, resolveToolName } from './tools.js';
import { buildNativeRegistry } from './native.js';
import { INTERNAL_ERROR, ToolError, errorMessage } from './errors.js';
import { redactUrl } from './url.js';
import { deadline } from './signal.js';

/** @typedef {import('@modelcontextprotocol/sdk/types.js').Tool} Tool */
/** @typedef {import('@modelcontextprotocol/sdk/types.js').CallToolResult} CallToolResult */

/**
 * A JSON-RPC 2.0 response envelope from the backend. Only the members the
 * bridge reads are typed; everything else passes through untouched.
 *
 * @typedef {object} BackendEnvelope
 * @property {{ code: number, message?: string, data?: unknown }} [error]
 * @property {BackendResult} [result]
 */

/**
 * @typedef {object} BackendResult
 * @property {unknown} [tools]
 * @property {CallToolResult['content']} [content]
 * @property {Record<string, unknown>} [structuredContent]
 * @property {boolean} [isError]
 */

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json');

// The bundled offline tool surface, re-exported so an embedder can read the
// advertised tools (and their annotations) without spawning the server.
export { FALLBACK_TOOLS, TOOL_ANNOTATIONS } from './tools.js';

const DEFAULT_BACKEND_URL = 'https://three.ws/api/pump-fun-mcp';

// Resolved per call, not once at import: the bin reads it at startup either way,
// and a lazy read lets an embedder (or a test) repoint the bridge after the module
// is already loaded.
const backendUrl = () => process.env.PUMPFUN_MCP_URL || DEFAULT_BACKEND_URL;

/**
 * The backend URL, checked to be http(s) before anything is sent to it.
 *
 * @returns {string}
 */
function checkedBackendUrl() {
	const raw = backendUrl();
	let protocol;
	try {
		protocol = new URL(raw).protocol;
	} catch {
		throw new Error('PUMPFUN_MCP_URL is not a valid URL');
	}
	if (protocol !== 'https:' && protocol !== 'http:') {
		throw new Error('PUMPFUN_MCP_URL must be an http(s) URL');
	}
	return raw;
}
const SERVER_NAME = 'three.ws-pumpfun-mcp';

// Upper bound for one backend round trip. The slowest backend tools
// (pumpfun_watch_whales, pumpfun_watch_claims) collect for at most 10 s.
const BACKEND_TIMEOUT_MS = 30_000;
const TOOLS_LIST_TIMEOUT_MS = 10_000;

// A monotonically increasing JSON-RPC id for backend calls. Local to this
// process; the backend is stateless so any unique id works.
let rpcId = 0;

/**
 * Post a JSON-RPC 2.0 request to the canonical backend and return its parsed
 * envelope. Throws on transport-level failure (network, non-2xx, bad JSON) so
 * callers surface a real error rather than a fabricated payload.
 *
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] `signal` is the
 *   MCP request's cancellation signal; the fetch stops when the client cancels.
 * @returns {Promise<BackendEnvelope>}
 */
async function callBackend(method, params, { timeoutMs = BACKEND_TIMEOUT_MS, signal } = {}) {
	const url = checkedBackendUrl();
	const limit = deadline(timeoutMs, signal);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
			signal: limit.signal,
		});
		if (!res.ok) {
			throw new Error(`backend ${redactUrl(url)} answered HTTP ${res.status}`);
		}
		return /** @type {BackendEnvelope} */ (await res.json());
	} catch (err) {
		if (limit.timedOut()) {
			throw new Error(`backend ${redactUrl(url)} did not answer within ${timeoutMs / 1000} s`);
		}
		if (signal?.aborted) throw new Error('request cancelled by the client');
		throw err;
	} finally {
		limit.dispose();
	}
}

/**
 * Fetch the authoritative tool list from the backend. Falls back to the
 * vendored static surface if the backend is unreachable at startup, so a
 * fresh install still advertises correct tools offline.
 *
 * @returns {Promise<Tool[]>}
 */
async function loadTools() {
	try {
		const env = await callBackend('tools/list', {}, { timeoutMs: TOOLS_LIST_TIMEOUT_MS });
		const tools = env?.result?.tools;
		if (Array.isArray(tools) && tools.length > 0) return /** @type {Tool[]} */ (tools);
	} catch (err) {
		process.stderr.write(
			`[pumpfun-mcp] tools/list unreachable (${errorMessage(err)}); using bundled tool list\n`,
		);
	}
	return FALLBACK_TOOLS;
}

/**
 * The first text block of an MCP content array, if any.
 *
 * @param {CallToolResult['content'] | undefined} content
 * @returns {string | undefined}
 */
function firstText(content) {
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block?.type === 'text' && typeof block.text === 'string') return block.text;
	}
	return undefined;
}

/**
 * Invoke a single backend tool and return its unwrapped structuredContent.
 * Throws on a JSON-RPC error envelope or an `isError` tool result so native
 * composers can treat an individual source as unavailable
 * (Promise.allSettled) without faking data.
 *
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function callTool(name, args, signal) {
	const env = await callBackend('tools/call', { name, arguments: args || {} }, { signal });
	if (env?.error) {
		throw new ToolError(env.error.message || `${name} failed`, env.error.code);
	}
	if (env?.result?.isError) {
		throw new ToolError(firstText(env.result.content) || `${name} failed`, INTERNAL_ERROR);
	}
	return env?.result?.structuredContent ?? null;
}

/**
 * Overlay the vendored title + ToolAnnotations onto a tool definition loaded
 * from the backend. An up-to-date backend already ships both (its values win);
 * an older deployed backend gets them filled in locally so clients always see
 * read-only/idempotency hints.
 *
 * @param {Tool} tool
 * @returns {Tool}
 */
function withLocalAnnotations(tool) {
	const canonical = resolveToolName(tool?.name);
	const local = typeof canonical === 'string' ? TOOL_ANNOTATIONS[canonical] : undefined;
	if (!local) return tool;
	return {
		...tool,
		title: tool.title ?? local.title,
		annotations: tool.annotations ?? local,
	};
}

/**
 * True when a tool definition is explicitly annotated read-only. This bridge is
 * read-only by contract, so a tool without that annotation is never exposed,
 * whatever the backend advertises.
 *
 * @param {Tool} tool
 * @returns {boolean}
 */
function isReadOnly(tool) {
	return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true;
}

/**
 * Build the fully-registered MCP server without connecting a transport. Asks the
 * backend for its authoritative tool list, so this is a live call; the bundled
 * FALLBACK_TOOLS cover an unreachable backend. Safe to import (tests, embedding
 * this bridge in another process).
 *
 * @returns {Promise<Server & { threeWsToolCount: number }>}
 */
export async function buildServer() {
	const backendTools = await loadTools();
	const native = buildNativeRegistry(backendUrl(), callTool);
	const nativeNames = new Set(native.defs.map((t) => t.name));
	/** @type {Tool[]} */
	const tools = [];
	for (const tool of [
		// A native tool replaces a backend tool of the same name.
		...backendTools.map(withLocalAnnotations).filter((t) => !nativeNames.has(t.name)),
		...native.defs,
	]) {
		if (isReadOnly(tool)) tools.push(tool);
		else {
			process.stderr.write(
				`[pumpfun-mcp] not exposing ${tool.name}: it is not annotated readOnlyHint=true\n`,
			);
		}
	}
	const advertised = new Set(tools.map((t) => t.name));
	/** Advertised names, plus legacy camelCase aliases of advertised names. */
	const isCallable = (/** @type {string} */ name) => {
		const canonical = resolveToolName(name);
		return advertised.has(name) || (typeof canonical === 'string' && advertised.has(canonical));
	};

	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: { tools: { listChanged: false } },
			instructions:
				'Free, read-only pump.fun + Solana tools from three.ws. Token discovery ' +
				'(search_tokens, get_trending_tokens, get_new_tokens, get_graduated_tokens, ' +
				'get_king_of_the_hill), on-chain analysis (get_bonding_curve, get_token_holders, ' +
				'get_token_details, get_token_trades), creator intelligence (get_creator_profile, ' +
				'pumpfun_list_claims, pumpfun_watch_claims, pumpfun_first_claims), Solana Name ' +
				'Service (sns_resolve, sns_reverseLookup), market signals (' +
				'kol_leaderboard, pumpfun_quote_swap, pumpfun_watch_whales, pumpfun_bot_status), ' +
				'and social sentiment (social_cashtag_sentiment, social_x_post_impact). All data ' +
				'is live and on-chain; no API keys required.',
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name, arguments: args } = request.params;

		// Only advertised (read-only) tools are forwarded. The backend serves
		// more than this bridge exposes, e.g. tools that write or need auth.
		if (!isCallable(name)) {
			throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
		}

		// Native composed tools run in-process (they orchestrate backend reads).
		const nativeHandler = native.handlers.get(name);
		if (nativeHandler) {
			try {
				const data = await nativeHandler(args || {}, extra.signal);
				return {
					content: [{ type: 'text', text: JSON.stringify(data) }],
					structuredContent: data,
				};
			} catch (err) {
				const code = err instanceof ToolError ? err.rpcCode : INTERNAL_ERROR;
				return {
					isError: true,
					content: [{ type: 'text', text: `[${code}] ${errorMessage(err) || 'tool error'}` }],
				};
			}
		}

		let env;
		try {
			env = await callBackend(
				'tools/call',
				{ name, arguments: args || {} },
				{ signal: extra.signal },
			);
		} catch (err) {
			return {
				isError: true,
				content: [{ type: 'text', text: `Backend request failed: ${errorMessage(err)}` }],
			};
		}

		// A JSON-RPC error envelope (unknown tool, invalid arg, indexer
		// unavailable, on-chain read failure) becomes an MCP tool error so the
		// client sees the real failure instead of a silent empty result.
		if (env?.error) {
			return {
				isError: true,
				content: [
					{
						type: 'text',
						text: `[${env.error.code}] ${env.error.message || 'tool error'}`,
					},
				],
			};
		}

		const result = env?.result;
		if (result?.content) {
			// Backend already returns MCP content + structuredContent — pass
			// through, including isError: a tool-execution failure must reach the
			// client as a failure, not as a successful result carrying error text.
			return {
				content: result.content,
				...(result.structuredContent !== undefined
					? { structuredContent: result.structuredContent }
					: {}),
				...(result.isError === true ? { isError: true } : {}),
			};
		}

		// Defensive: a well-formed-but-shapeless result still gets surfaced as text.
		return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
	});

	return Object.assign(server, { threeWsToolCount: tools.length });
}

async function main() {
	checkedBackendUrl();
	const server = await buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(
		`[pumpfun-mcp] ${SERVER_NAME} v${SERVER_VERSION} ready with ${server.threeWsToolCount} tools via ${redactUrl(backendUrl())}\n`,
	);
}

// Connect stdio ONLY when this file is the process entry point. Importing the
// module (tests, embedding) must not grab the transport or the process's stdin
// and stdout. realpath both sides: npm bin shims are symlinks, so argv[1] may
// differ from import.meta.url.
function isProcessEntryPoint() {
	if (!process.argv[1]) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isProcessEntryPoint()) {
	main().catch((err) => {
		process.stderr.write(`[pumpfun-mcp] fatal: ${err?.stack || err}\n`);
		process.exit(1);
	});
}
