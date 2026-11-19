// Errors that carry the JSON-RPC code the bridge reports for them, so a tool
// failure surfaces as `[<code>] <message>` instead of a generic -32603.

export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const NO_DATA = -32004;

export class ToolError extends Error {
	/**
	 * @param {string} message
	 * @param {number} rpcCode JSON-RPC error code reported to the client.
	 */
	constructor(message, rpcCode) {
		super(message);
		this.name = 'ToolError';
		this.rpcCode = rpcCode;
	}
}

/**
 * Message of an unknown thrown value, without assuming it is an Error.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
	if (err instanceof Error) return err.message;
	return String(err);
}
