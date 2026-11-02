// The one document fingerprint format: `sha256:`-prefixed lowercase hex.

import crypto from 'node:crypto';

/**
 * Canonical fingerprint of some bytes: `sha256:` + lowercase hex. Accepts a
 * Buffer, Uint8Array, or utf8 string. Pure.
 * @param {Buffer | Uint8Array | string} bytes
 * @returns {string}
 * @when Use to fingerprint a file the same way mailproof does, e.g. to compare against `record.attachments[].sha256` yourself. `mp.matchFile()` does this for you.
 * @category hash
 * @signature hashDocument(bytes: Buffer|Uint8Array|string) => string
 * @fails Never throws on bytes or a string; throws a TypeError for any other input type.
 * @example
 * import { hashDocument } from 'mailproof';
 * hashDocument(Buffer.from('hello'));   // 'sha256:2cf24d...'
 */
function hashDocument(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export { hashDocument };
