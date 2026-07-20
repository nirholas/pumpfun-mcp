// Tool-surface invariants for the vendored fallback catalog and the local
// annotations overlay. Every tool this bridge advertises must be a complete,
// explicitly read-only MCP tool definition — a new entry without annotations
// (or one marked destructive) fails here before it can ship.
//
// Run: node --test packages/pumpfun-mcp/test/tools.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { FALLBACK_TOOLS, TOOL_ANNOTATIONS } from '../src/tools.js';
import { NATIVE_TOOLS } from '../src/native.js';

test('FALLBACK_TOOLS is a non-empty array', () => {
	assert.ok(Array.isArray(FALLBACK_TOOLS));
	assert.ok(FALLBACK_TOOLS.length > 0);
});

test('every fallback tool has name, description, inputSchema, title', () => {
	for (const tool of FALLBACK_TOOLS) {
		assert.equal(typeof tool.name, 'string', 'name must be a string');
		assert.ok(tool.name.length > 0, 'name must be non-empty');
		assert.equal(typeof tool.description, 'string', `${tool.name}: description`);
		assert.ok(tool.description.length > 0, `${tool.name}: description non-empty`);
		assert.ok(tool.inputSchema, `${tool.name}: inputSchema`);
		assert.equal(tool.inputSchema.type, 'object', `${tool.name}: inputSchema.type`);
		assert.equal(typeof tool.title, 'string', `${tool.name}: title`);
		assert.ok(tool.title.length > 0, `${tool.name}: title non-empty`);
	}
});

test('every fallback tool carries read-only MCP annotations', () => {
	for (const tool of FALLBACK_TOOLS) {
		const a = tool.annotations;
		assert.ok(a && typeof a === 'object', `${tool.name}: annotations object`);
		assert.equal(typeof a.readOnlyHint, 'boolean', `${tool.name}: readOnlyHint boolean`);
		assert.equal(a.readOnlyHint, true, `${tool.name}: must be read-only`);
		// destructiveHint defaults to true in the MCP spec when omitted — this
		// surface must set it explicitly false, never true.
		assert.equal(a.destructiveHint, false, `${tool.name}: destructiveHint must be false`);
		assert.equal(typeof a.idempotentHint, 'boolean', `${tool.name}: idempotentHint boolean`);
		assert.equal(typeof a.openWorldHint, 'boolean', `${tool.name}: openWorldHint boolean`);
	}
});

test('fallback tool names are unique', () => {
	const names = FALLBACK_TOOLS.map((t) => t.name);
	assert.equal(new Set(names).size, names.length);
});

test('TOOL_ANNOTATIONS covers every fallback tool name', () => {
	for (const tool of FALLBACK_TOOLS) {
		assert.ok(
			Object.hasOwn(TOOL_ANNOTATIONS, tool.name),
			`${tool.name}: missing from TOOL_ANNOTATIONS overlay map`,
		);
	}
});

test('semantic spot checks: deterministic and local-compute tools', () => {
	assert.equal(TOOL_ANNOTATIONS.sns_resolve.idempotentHint, true);
	assert.equal(TOOL_ANNOTATIONS.sns_reverseLookup.idempotentHint, true);
	// Pure lexicon scorer: deterministic and closed-world.
	assert.equal(TOOL_ANNOTATIONS.social_cashtag_sentiment.idempotentHint, true);
	assert.equal(TOOL_ANNOTATIONS.social_cashtag_sentiment.openWorldHint, false);
	// Vanity grind: local compute, fresh keypair every call.
	assert.equal(TOOL_ANNOTATIONS.pumpfun_vanity_mint.idempotentHint, false);
	assert.equal(TOOL_ANNOTATIONS.pumpfun_vanity_mint.openWorldHint, false);
});

// Any outputSchema this bridge advertises is a contract the client validates
// structuredContent against. A `required` entry with no matching property is a
// schema that can never be satisfied, so it must be caught here, not in a client.
test('declared outputSchemas are internally consistent', () => {
	const withSchema = FALLBACK_TOOLS.filter((t) => t.outputSchema);
	assert.ok(withSchema.length > 0, 'expected at least one tool to declare an outputSchema');
	for (const tool of withSchema) {
		const s = tool.outputSchema;
		assert.equal(s.type, 'object', `${tool.name}: outputSchema.type`);
		assert.ok(s.properties && typeof s.properties === 'object', `${tool.name}: properties`);
		for (const key of s.required || []) {
			assert.ok(
				Object.hasOwn(s.properties, key),
				`${tool.name}: required "${key}" has no property definition`,
			);
			assert.equal(
				typeof s.properties[key].type,
				'string',
				`${tool.name}: property "${key}" needs a type`,
			);
		}
	}
});

// A pump.fun coin is priced by the bonding curve before graduation and by the
// PumpSwap pool after it. Both accounts now carry a field spelled
// virtual_quote_reserves, and they are NOT the same quantity. These tools are
// read by a model with no human in the loop, so each pricing tool has to say
// which account it reads. Dropping that wording is a real regression: it lets a
// caller apply pool math to curve reserves (or vice versa) and get a confidently
// wrong price with no error anywhere.
const byName = (name) => {
	const tool = FALLBACK_TOOLS.find((t) => t.name === name);
	assert.ok(tool, `${name}: missing from FALLBACK_TOOLS`);
	return tool;
};

test('get_bonding_curve documents the renamed quote-side curve fields', () => {
	const tool = byName('get_bonding_curve');
	assert.match(tool.description, /bonding[- ]curve account/i);
	assert.match(tool.description, /virtual_quote_reserves/);
	// The rename is the trap: a decoder still reading virtual_sol_reserves gets
	// undefined, which coerces to a 0 price rather than throwing.
	assert.match(tool.description, /virtual_sol_reserves/);
	// Reserve fields must name their on-chain source so the rename is traceable.
	const props = tool.outputSchema.properties;
	assert.match(props.solReserves.description, /real_quote_reserves/);
	assert.match(props.virtualSolReserves.description, /virtual_quote_reserves/);
});

test('pumpfun_quote_swap documents pricing against effective quote reserves', () => {
	const tool = byName('pumpfun_quote_swap');
	// effective = vault balance + pool.virtual_quote_reserves.
	assert.match(tool.description, /effective/i);
	assert.match(tool.description, /pool\.virtual_quote_reserves/);
	assert.match(tool.description, /pool_quote_token_account\.amount/);
	// The base side is explicitly unchanged upstream, so the description says so.
	// Without it, a reader may "symmetrically" add a virtual figure to the base.
	assert.match(tool.description, /pool_base_token_account\.amount/);
	assert.match(tool.outputSchema.properties.priceImpactBps.description, /effective quote reserve/i);
});

test('native composed tools carry the same annotation contract', () => {
	assert.ok(NATIVE_TOOLS.length > 0);
	const fallbackNames = new Set(FALLBACK_TOOLS.map((t) => t.name));
	for (const { def } of NATIVE_TOOLS) {
		assert.ok(!fallbackNames.has(def.name), `${def.name}: collides with a fallback tool`);
		assert.equal(typeof def.title, 'string', `${def.name}: title`);
		const a = def.annotations;
		assert.ok(a && typeof a === 'object', `${def.name}: annotations object`);
		assert.equal(a.readOnlyHint, true, `${def.name}: must be read-only`);
		assert.equal(a.destructiveHint, false, `${def.name}: destructiveHint must be false`);
		assert.equal(typeof a.idempotentHint, 'boolean', `${def.name}: idempotentHint boolean`);
		assert.equal(typeof a.openWorldHint, 'boolean', `${def.name}: openWorldHint boolean`);
	}
});

// The MCP registry rejects a server.json whose declared version disagrees with
// the npm package it points at, and npm rejects a republish of an existing
// version. Both have bitten this package: npm reached 0.2.3 while package.json
// still read 0.2.1, because publish-time bumps were never committed back. That
// left the repo unable to publish and misreporting what was live.
test('server.json and package.json declare the same version', async () => {
	const [pkg, server] = await Promise.all([
		readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
		readFile(new URL('../server.json', import.meta.url), 'utf8').then(JSON.parse),
	]);

	assert.equal(server.version, pkg.version, 'server.json version must track package.json');

	const npmEntry = server.packages?.find(
		(p) => p.registryType === 'npm' && p.identifier === pkg.name,
	);
	assert.ok(npmEntry, `server.json must carry an npm package entry for ${pkg.name}`);
	assert.equal(
		npmEntry.version,
		pkg.version,
		'server.json packages[].version must track package.json',
	);

	// mcpName is what ties the npm package to its registry identity; a mismatch
	// publishes an orphaned registry entry that resolves to nothing.
	assert.equal(pkg.mcpName, server.name, 'package.json mcpName must equal server.json name');
});
