// The trail's file layout (SPEC B3): the one place that builds or parses a record or reply path. Dependency-free
// (node:fs and node:path only) so the worker thread can import it through reply-text.js.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Records and replies are sharded by the first two hex chars of the record id (256 directories, 00-ff), so a
// commit rewrites one small shard tree, not one tree entry per record (findings F24). Every builder and parser of
// these paths is below; nothing else spells them.
/** @param {string} id  32 lowercase hex. @returns {string} */
const recordPath = (id) => `records/${id.slice(0, 2)}/${id}.json`;
/** @param {string} id @returns {string}  The OpenTimestamps proof beside the record. */
const recordOtsPath = (id) => `${recordPath(id)}.ots`;
/** @param {string} id @param {string} slug  The stripper version with `/` as `-`. @returns {string} */
const replyPath = (id, slug) => `replies/${id.slice(0, 2)}/${id}.${slug}.json`;
/** @param {number} seq  1..99,999,999. @returns {string} The stamp manifest (SPEC B13.1.2): flat directory, names sort in chain order. */
const manifestPath = (seq) => `manifests/${String(seq).padStart(8, '0')}.json`;
/** @param {number} seq @returns {string} The OpenTimestamps proof of a manifest. */
const manifestOtsPath = (seq) => `${manifestPath(seq)}.ots`;
/**
 * The archived DKIM key file of a signing domain, selector and public key (`p`, base64): `keys/<domain>/<selector>/<16 hex>.json`,
 * domain and selector lower-cased, the 16 hex the start of the sha256 of `p`.
 * @param {string} domain
 * @param {string} selector
 * @param {string} p
 * @returns {string}
 */
const keyPath = (domain, selector, p) => `keys/${domain.toLowerCase()}/${selector.toLowerCase()}/${crypto.createHash('sha256').update(p).digest('hex').slice(0, 16)}.json`;
const KEY_LABEL_RE = /^[a-z0-9._-]+$/;
const KEY_FILE_RE = /^keys\/([^/]+)\/([^/]+)\/([0-9a-f]{16})\.json$/;
const MANIFEST_FILE_RE = /^manifests\/(\d{8})\.json(\.ots)?$/;
const RECORD_FILE_RE = /^records\/([0-9a-f]{2})\/([0-9a-f]{32})\.json(\.ots)?$/;
const REPLY_FILE_RE = /^replies\/([0-9a-f]{2})\/([0-9a-f]{32})\.([a-z0-9-]+)\.json$/;

/**
 * Parse a trail-relative record path (`records/<2hex>/<32hex>.json` or `.json.ots`; the shard must be the id's own).
 * @param {string} rel
 * @returns {{ id: string, ots: boolean } | null}
 */
function parseRecordPath(rel) {
  const m = RECORD_FILE_RE.exec(rel);
  return m && m[2].startsWith(m[1]) ? { id: m[2], ots: m[3] !== undefined } : null;
}

/**
 * Parse a trail-relative key path (`keys/<domain>/<selector>/<16 hex>.json`; domain and selector lowercase, the characters
 * a DKIM name may have, neither starting with a dot nor holding `..`).
 * @param {string} rel
 * @returns {{ domain: string, selector: string, h16: string } | null}
 */
function parseKeyPath(rel) {
  const m = KEY_FILE_RE.exec(rel);
  if (!m) return null;
  const ok = (/** @type {string} */ l) => KEY_LABEL_RE.test(l) && !l.startsWith('.') && !l.includes('..');
  return ok(m[1]) && ok(m[2]) ? { domain: m[1], selector: m[2], h16: m[3] } : null;
}

/** The two files of a bundle that are not trail paths (SPEC B13.2.4). */
const BUNDLE_README = 'README.txt';
const BUNDLE_JSON = 'bundle.json';

/**
 * Classify a bundle-relative path (SPEC B13.2.4): the trail's own paths, parsed by the parsers above, or exactly `README.txt` /
 * `bundle.json`. Anything else is null (`unexpected path`).
 * @param {string} rel
 * @returns {{ kind: 'readme' | 'bundle' } | { kind: 'record', id: string, ots: boolean } | { kind: 'reply', id: string, slug: string } | { kind: 'key', domain: string, selector: string, h16: string } | { kind: 'manifest', seq: number, ots: boolean } | null}
 */
function parseBundlePath(rel) {
  if (rel === BUNDLE_README) return { kind: 'readme' };
  if (rel === BUNDLE_JSON) return { kind: 'bundle' };
  const r = parseRecordPath(rel);
  if (r) return { kind: 'record', id: r.id, ots: r.ots };
  const y = parseReplyPath(rel);
  if (y) return { kind: 'reply', id: y.id, slug: y.slug };
  const k = parseKeyPath(rel);
  if (k) return { kind: 'key', ...k };
  const m = parseManifestPath(rel);
  return m ? { kind: 'manifest', seq: m.seq, ots: m.ots } : null;
}

/**
 * Parse a trail-relative manifest path (`manifests/<8 digits>.json` or `.json.ots`; seq 1..99,999,999).
 * @param {string} rel
 * @returns {{ seq: number, ots: boolean } | null}
 */
function parseManifestPath(rel) {
  const m = MANIFEST_FILE_RE.exec(rel);
  if (!m) return null;
  const seq = Number(m[1]);
  return seq >= 1 ? { seq, ots: m[2] !== undefined } : null;
}

/**
 * Parse a trail-relative reply-text path (`replies/<2hex>/<32hex>.<slug>.json`; the shard must be the id's own).
 * @param {string} rel
 * @returns {{ id: string, slug: string } | null}
 */
function parseReplyPath(rel) {
  const m = REPLY_FILE_RE.exec(rel);
  return m && m[2].startsWith(m[1]) ? { id: m[2], slug: m[3] } : null;
}

/** @param {string} rel @returns {boolean}  Is it a reply-text path (see parseReplyPath)? */
function isReplyPath(rel) {
  return parseReplyPath(rel) !== null;
}

/**
 * The ids of the record files (not their `.ots`) named by a NUL-separated git path list. Duplicates are not removed.
 * @param {string} out
 * @returns {string[]}
 */
function recordIdsFromPaths(out) {
  /** @type {string[]} */
  const ids = [];
  for (const p of out.split('\0')) { const r = parseRecordPath(p); if (r && !r.ots) ids.push(r.id); }
  return ids;
}

/**
 * Fail with `ERR_TRAIL_LAYOUT` when the trail still has the pre-M3 flat layout (`records/<32hex>.json` at the top
 * of `records/`). Cheap: it stops at the first flat file, and a sharded trail has at most 256 entries there.
 * No conversion exists: the trail must be re-created.
 * @param {string} root
 * @returns {Promise<void>}
 */
async function assertTrailLayout(root) {
  /** @type {import('node:fs').Dir} */
  let dir;
  try { dir = await fs.opendir(path.join(root, 'records')); } catch { return; }
  try {
    for await (const e of dir) {
      if (e.isFile() && /^[0-9a-f]{32}\.json$/.test(e.name)) {
        throw Object.assign(new Error(`trail "${path.basename(root)}" uses the pre-M3 flat layout (records/<id>.json); it must be re-created, mailproof does not convert it`), { code: 'ERR_TRAIL_LAYOUT' });
      }
    }
  } finally { await dir.close().catch(() => {}); }
}

export { keyPath, parseKeyPath, BUNDLE_README, BUNDLE_JSON, parseBundlePath, recordPath, recordOtsPath, replyPath, manifestPath, manifestOtsPath, parseManifestPath, parseRecordPath, parseReplyPath, isReplyPath, recordIdsFromPaths, assertTrailLayout };
