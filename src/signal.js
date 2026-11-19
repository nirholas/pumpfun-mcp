// Abort plumbing for outbound requests: every upstream fetch gets a deadline,
// and also stops as soon as the MCP client cancels the tool call.

/**
 * @typedef {object} Deadline
 * @property {AbortSignal} signal Aborts on timeout or when the parent aborts.
 * @property {() => boolean} timedOut True when the deadline, not the parent, fired.
 * @property {() => void} dispose Clears the timer and detaches from the parent.
 */

/**
 * @param {number} ms
 * @param {AbortSignal} [parent] The MCP request's cancellation signal.
 * @returns {Deadline}
 */
export function deadline(ms, parent) {
	const controller = new AbortController();
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(new Error(`timed out after ${ms} ms`));
	}, ms);
	const onAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) onAbort();
	else parent?.addEventListener('abort', onAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => expired,
		dispose() {
			clearTimeout(timer);
			parent?.removeEventListener('abort', onAbort);
		},
	};
}
