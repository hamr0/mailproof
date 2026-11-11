// The trail's file layout (SPEC B3): the one place that builds or parses a record or reply path. Dependency-free
// (node:fs and node:path only) so the worker thread can import it through reply-text.js.

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

export { recordPath, recordOtsPath, replyPath, manifestPath, manifestOtsPath, parseManifestPath, parseRecordPath, parseReplyPath, isReplyPath, recordIdsFromPaths, assertTrailLayout };
