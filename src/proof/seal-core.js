// The pure half of the seal (SPEC B13.1.3, B13.1.10): the manifest bytes and parser, the chain error, and the ONE function that
// decides a file's seal from the manifests. It imports nothing of the trail, git or the content store, so `verify-bundle`
// (B13.3) runs the very code `findSeal` and `export` run, on a bundle, with nothing of the owner's installed.

import crypto from 'node:crypto';

/** @typedef {{ v: 1, seq: number, previous_sha256: string | null, created: string, records: Array<[string, string]>, replies: Array<[string, string, string]> }} Manifest */

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SLUG = /^[a-z0-9-]+$/;
const MANIFEST_KEYS = ['v', 'seq', 'previous_sha256', 'created', 'records', 'replies'];

/** @param {Buffer | string} b @returns {string} */
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * `ERR_STAMP_CHAIN`: the committed manifest chain is broken; a stamp job must not extend it.
 * @param {number} seq
 * @param {string} why
 * @returns {Error & { code: 'ERR_STAMP_CHAIN', seq: number }}
 */
const chainError = (seq, why) => Object.assign(new Error(`stamp chain broken at seq ${seq}: ${why}`), { code: /** @type {const} */ ('ERR_STAMP_CHAIN'), seq });

/**
 * The manifest file, exactly (SPEC B13.1.3): UTF-8, LF, fixed key order, two-space indent, one entry per line, a final
 * newline. The hash of a manifest is the hash of these bytes as stored; a verifier never re-serialises.
 * @param {Manifest} m
 * @returns {string}
 */
function serialiseManifest(m) {
  const entry = (/** @type {string[]} */ e) => `    [${e.map((x) => JSON.stringify(x)).join(', ')}]`;
  const list = (/** @type {string[][]} */ es) => (es.length ? `[\n${es.map(entry).join(',\n')}\n  ]` : '[]');
  return [
    '{',
    `  "v": ${m.v},`,
    `  "seq": ${m.seq},`,
    `  "previous_sha256": ${JSON.stringify(m.previous_sha256)},`,
    `  "created": ${JSON.stringify(m.created)},`,
    `  "records": ${list(m.records)},`,
    `  "replies": ${list(m.replies)}`,
    '}',
  ].join('\n') + '\n';
}

/**
 * Parse manifest bytes strictly: only the schema's keys, `v` 1, `seq` the file name's, entries of the right shape, sorted
 * strictly ascending (records by id, replies by id then slug). The previous-hash link is checked by the chain, not here.
 * @param {Buffer} bytes
 * @param {number} seq  The number in the file name.
 * @returns {{ ok: true, manifest: Manifest } | { ok: false, why: string }}
 */
function parseManifest(bytes, seq) {
  /** @type {any} */
  let j;
  try { j = JSON.parse(bytes.toString('utf8')); } catch { return { ok: false, why: 'does not parse' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, why: 'not an object' };
  const keys = Object.keys(j);
  if (keys.length !== MANIFEST_KEYS.length || !MANIFEST_KEYS.every((k) => keys.includes(k))) return { ok: false, why: 'fields are not the manifest schema' };
  if (j.v !== 1) return { ok: false, why: `unknown version ${JSON.stringify(j.v)}` };
  if (j.seq !== seq) return { ok: false, why: `seq ${JSON.stringify(j.seq)} is not its file name` };
  if (j.previous_sha256 !== null && !(typeof j.previous_sha256 === 'string' && HEX64.test(j.previous_sha256))) return { ok: false, why: 'bad previous_sha256' };
  if (typeof j.created !== 'string') return { ok: false, why: 'bad created' };
  if (!Array.isArray(j.records) || !Array.isArray(j.replies)) return { ok: false, why: 'records and replies must be lists' };
  let last = '';
  for (const e of j.records) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || typeof e[1] !== 'string' || !HEX32.test(e[0]) || !HEX64.test(e[1])) return { ok: false, why: 'bad record entry' };
    if (e[0] <= last) return { ok: false, why: 'record entries are not in ascending order' };
    last = e[0];
  }
  last = '';
  for (const e of j.replies) {
    if (!Array.isArray(e) || e.length !== 3 || typeof e[0] !== 'string' || typeof e[1] !== 'string' || typeof e[2] !== 'string' || !HEX32.test(e[0]) || !SLUG.test(e[1]) || !HEX64.test(e[2])) return { ok: false, why: 'bad reply entry' };
    const k = `${e[0]}.${e[1]}`;
    if (k <= last) return { ok: false, why: 'reply entries are not in ascending order' };
    last = k;
  }
  return { ok: true, manifest: j };
}


/**
 * What the decision needs to know about one manifest: its parsed content, the sha256 of its bytes and whether it has a proof.
 * @typedef {{ m: Manifest, sha256: string, ots: boolean }} LoadedManifest
 */

/**
 * Decide the seal of a record or reply-text file (SPEC B13.1.10), from the manifests only. One definition: `findSeal` (the
 * trail), `export` and `verify-bundle` all call it, each with its own loader.
 *   1. The file's own proof (`own`: a 3.3.0 or `record`-mode `.json.ots` beside a record) wins.
 *   2. Else the first manifest in `order` that lists the file with its current hash (`lists`); then the stamp: that manifest's own
 *      proof, else the nearest later manifest that has one, reached by consecutive `seq` with each `previous_sha256` equal to the
 *      hash of the bytes before it (a missing, unparsable or unlinked manifest ends the walk: no stamp).
 *   3. Else null: unsealed.
 * `load` may be async (the trail reads blobs lazily); the function does no I/O of its own.
 * @param {{ own?: boolean, order: number[], load: (seq: number) => LoadedManifest | null | Promise<LoadedManifest | null>, lists: (m: Manifest) => boolean }} a
 * @returns {Promise<{ via: 'record' } | { via: 'manifest', seq: number, stamp: { seq: number, own: boolean } | null } | null>}
 */
async function decideSeal({ own = false, order, load, lists }) {
  if (own) return { via: 'record' };
  /** @type {LoadedManifest | null} */
  let first = null;
  let found = -1;
  for (const seq of order) {
    const x = await load(seq);
    if (x && lists(x.m)) { found = seq; first = x; break; }
  }
  if (found < 0 || !first) return null;
  if (first.ots) return { via: 'manifest', seq: found, stamp: { seq: found, own: true } };
  let prev = first;
  for (let seq = found + 1; ; seq++) {
    const cur = await load(seq);
    if (!cur || cur.m.seq !== seq || cur.m.previous_sha256 !== prev.sha256) break;
    if (cur.ots) return { via: 'manifest', seq: found, stamp: { seq, own: false } };
    prev = cur;
  }
  return { via: 'manifest', seq: found, stamp: null };
}

export { sha256Hex, chainError, serialiseManifest, parseManifest, decideSeal };
