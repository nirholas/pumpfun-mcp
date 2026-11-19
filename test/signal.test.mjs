// The deadline helper behind every upstream fetch: it must fire on time,
// follow the MCP request's cancellation, and clean up after itself.
//
// Run: node --test test/signal.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deadline } from '../src/signal.js';

test('the deadline aborts after the timeout and reports timedOut', async () => {
	const limit = deadline(20);
	await new Promise((resolve) => limit.signal.addEventListener('abort', resolve, { once: true }));
	assert.equal(limit.timedOut(), true);
	assert.match(String(limit.signal.reason?.message), /timed out after 20 ms/);
	limit.dispose();
});

test('a parent abort propagates immediately and is not reported as a timeout', () => {
	const parent = new AbortController();
	const limit = deadline(60_000, parent.signal);
	parent.abort(new Error('client cancelled'));
	assert.equal(limit.signal.aborted, true);
	assert.equal(limit.timedOut(), false);
	assert.equal(limit.signal.reason.message, 'client cancelled');
	limit.dispose();
});

test('an already-aborted parent yields an already-aborted signal', () => {
	const parent = new AbortController();
	parent.abort();
	const limit = deadline(60_000, parent.signal);
	assert.equal(limit.signal.aborted, true);
	limit.dispose();
});

test('dispose stops the timer and detaches from the parent', async () => {
	const parent = new AbortController();
	const limit = deadline(10, parent.signal);
	limit.dispose();
	await new Promise((resolve) => setTimeout(resolve, 30));
	parent.abort();
	assert.equal(limit.signal.aborted, false);
	assert.equal(limit.timedOut(), false);
});
