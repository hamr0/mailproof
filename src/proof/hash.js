// The one document fingerprint format: `sha256:`-prefixed lowercase hex.

import crypto from 'node:crypto';

/**
 * Canonical fingerprint of some bytes: `sha256:` + lowercase hex. Accepts a
 * Buffer, Uint8Array, or utf8 string. Pure.
 * @param {Buffer | Uint8Array | string} bytes
 * @returns {string}
 */
function hashDocument(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export { hashDocument };
