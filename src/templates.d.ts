/**
 * Map an occasion `kind` (+ its ctx) to a neutral `{ subject, defaultBody }`.
 * The returned keys spread directly into deliver(). Pure.
 * @param {string} kind
 * @param {Record<string, any>} [ctx]
 * @returns {{ subject: string, defaultBody: string }}
 */
export function renderDefault(kind: string, ctx?: Record<string, any>): {
    subject: string;
    defaultBody: string;
};
/**
 * Render a stats snapshot as a plain ASCII body. Pure.
 * @param {Record<string, any>} [s]
 * @returns {string}
 */
export function statsBody(s?: Record<string, any>): string;
