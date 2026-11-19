// URL helpers shared by the bridge and the native tools.

/**
 * The origin of a URL, for logs and error text. A self-hosted backend URL can
 * carry credentials, an API key in the query string or a token in the path, and
 * error text reaches the model, so nothing past the origin is ever echoed.
 *
 * @param {string} raw
 * @returns {string}
 */
export function redactUrl(raw) {
	try {
		const { origin } = new URL(raw);
		return origin === 'null' ? '<non-http URL>' : origin;
	} catch {
		return '<invalid URL>';
	}
}
