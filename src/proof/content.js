// The local content store (SPEC B7, M3): the raw email and its attachments, kept beside the trail and outside git so a
// shared or exported proof never carries them. Files are keyed by hash, so every read re-hashes and self-verifies.
//
//   <trailDir>/<trail>.content/raw/<id[0:2]>/<id>.eml          the raw bytes; id = first 32 hex of their sha256
//   <trailDir>/<trail>.content/att/<hex[0:2]>/<hex>            an attachment; hex = its full sha256
//
// Everything here takes paths and bytes; the trail lock is taken by the caller (mailproof.js, trail.js) for any
// call that mutates shared state. Reads take no lock. Nothing in this module touches git or the record files
// except to READ them (retention needs `captured`, deduplication needs `attachments`).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRecord, RECORD_ID_RE, headOf, isAncestor, recordIdsSince } from './trail.js';
import { MAX_TOTAL_BYTES, MAX_HEADER_BYTES } from './limits.js';
import { extractAddresses } from './recheck.js';
import { splitMessage } from './signed-headers.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {{ store: boolean, attachments: boolean, days: number }} ContentConfig */
/** @typedef {{ stored: boolean, attachments: number, error?: string }} ContentResult */

/** @type {Readonly<ContentConfig>} */
const DEFAULTS = Object.freeze({ store: true, attachments: true, days: 730 });
const DAY_MS = 86_400_000;
const SHA_HEX_RE = /^[0-9a-f]{64}$/;
const TMP_MARK = '.tmp-';

/**
 * Validate the `content` constructor option.
 * @param {unknown} o
 * @returns {ContentConfig}
 * @throws {Error} on a non-object, an unknown key, a non-boolean flag, or `days` that is not a positive integer.
 */
function parseContentOptions(o) {
  if (o === undefined) return { ...DEFAULTS };
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error('Mailproof: content must be an object');
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in DEFAULTS)) throw new Error(`Mailproof: unknown content option "${k}"`);
    if (v === undefined) continue;
    if (k === 'days') {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new Error('Mailproof: content.days must be a positive integer');
      cfg.days = v;
    } else {
      if (typeof v !== 'boolean') throw new Error(`Mailproof: content.${k} must be a boolean`);
      cfg[/** @type {'store' | 'attachments'} */ (k)] = v;
    }
  }
  return cfg;
}

/** @param {string} root  The trail directory (`<trailDir>/<trail>`). @returns {string} */
const contentDirOf = (root) => `${root}.content`;
/** @param {string} dir @param {string} id @returns {string} */
const rawPathOf = (dir, id) => path.join(dir, 'raw', id.slice(0, 2), `${id}.eml`);
/** @param {string} dir @param {string} hex @returns {string} */
const attPathOf = (dir, hex) => path.join(dir, 'att', hex.slice(0, 2), hex);
/** @param {Buffer | string} bytes @returns {string} */
const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
/** @param {string} p @returns {Promise<boolean>} */
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
/** @param {unknown} e @returns {string | undefined} */
const codeOf = (e) => (e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' ? e.code : undefined);

/**
 * Write `bytes` to `abs` once: temp file in the same directory, fsync, then a hard link to the final name (a link
 * never replaces an existing file, so a concurrent or earlier copy is kept), then the temp name is dropped. Files
 * are 0600 and the directories made for them 0700 (it is other people's mail).
 * @param {string} abs
 * @param {Buffer} bytes
 * @returns {Promise<boolean>}  True when this call created the file, false when it already existed.
 */
async function writeOnce(abs, bytes) {
  if (await exists(abs)) return false;
  await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = `${abs}${TMP_MARK}${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fh = await fs.open(tmp, 'wx', 0o600);
    try { await fh.writeFile(bytes); await fh.sync(); } finally { await fh.close(); }
    try { await fs.link(tmp, abs); return true; }
    catch (e) { if (codeOf(e) === 'EEXIST') return false; throw e; }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * What the content store should write for one captured message.
 * @typedef {Object} ContentJob
 * @property {string} id  Record id.
 * @property {Buffer | null} raw  The raw bytes, or null when they are not held (a streamed over-size message).
 * @property {Array<{ sha256: string, bytes: Buffer }>} attachments  `sha256` as in the record (`sha256:<hex>`).
 */

/**
 * Write the raw email and attachments of one message into the store. Never throws: a failure (ENOSPC, EACCES)
 * is returned, because the proof must not be lost to a content problem. Raw bytes over the whole-message gate
 * (25 MiB) are not stored; attachments are stored only with a stored raw and `cfg.attachments`.
 * @param {string} dir  The content directory.
 * @param {ContentConfig} cfg
 * @param {ContentJob} job
 * @returns {Promise<{ result: ContentResult, created: string[] }>}  `created`: the files this call made (for rollback).
 */
async function storeContent(dir, cfg, job) {
  /** @type {string[]} */
  const created = [];
  if (!job.raw || job.raw.length > MAX_TOTAL_BYTES) return { result: { stored: false, attachments: 0 }, created };
  try {
    if (await writeOnce(rawPathOf(dir, job.id), job.raw)) created.push(rawPathOf(dir, job.id));
  } catch (e) {
    return { result: { stored: false, attachments: 0, error: errText(e) }, created };
  }
  let n = 0;
  /** @type {string | undefined} */
  let error;
  if (cfg.attachments) {
    for (const a of job.attachments) {
      const hex = a.sha256.replace(/^sha256:/, '');
      if (!SHA_HEX_RE.test(hex)) continue;
      try {
        if (await writeOnce(attPathOf(dir, hex), a.bytes)) created.push(attPathOf(dir, hex));
        n++;
      } catch (e) { error ??= errText(e); }
    }
  }
  return { result: { stored: true, attachments: n, ...(error ? { error } : {}) }, created };
}

/** @param {unknown} e @returns {string} */
const errText = (e) => (e instanceof Error ? `${codeOf(e) ?? e.name}: ${e.message}` : String(e)).slice(0, 300);

/**
 * Read a stored file and check its bytes against the hash its name promises.
 * @param {string} abs
 * @param {(buf: Buffer) => boolean} ok
 * @returns {Promise<{ buf: Buffer | null, status: 'ok' | 'absent' | 'corrupt' }>}
 */
async function readChecked(abs, ok) {
  let buf;
  try { buf = await fs.readFile(abs); } catch { return { buf: null, status: 'absent' }; }
  return ok(buf) ? { buf, status: 'ok' } : { buf: null, status: 'corrupt' };
}

/**
 * The raw email of a record id, re-hashed on read. A file whose hash is not the id is never returned.
 * @param {string} dir
 * @param {string} id
 * @returns {Promise<{ buf: Buffer | null, status: 'ok' | 'absent' | 'corrupt' }>}
 */
function readRaw(dir, id) {
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return Promise.resolve({ buf: null, status: 'absent' });
  return readChecked(rawPathOf(dir, id), (b) => sha256Of(b).slice(0, 32) === id);
}

/**
 * An attachment by sha256 (`sha256:<hex>` or bare hex), re-hashed on read.
 * @param {string} dir
 * @param {string} sha
 * @returns {Promise<{ buf: Buffer | null, status: 'ok' | 'absent' | 'corrupt' }>}
 */
function readAttachment(dir, sha) {
  const hex = typeof sha === 'string' ? sha.replace(/^sha256:/, '').toLowerCase() : '';
  if (!SHA_HEX_RE.test(hex)) return Promise.resolve({ buf: null, status: 'absent' });
  return readChecked(attPathOf(dir, hex), (b) => sha256Of(b) === hex);
}

/**
 * Ids that have a raw file in the store (also clears temp files a crashed writer left; caller holds the trail lock).
 * @param {string} dir
 * @param {{ sweepTemp?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
async function storedIds(dir, { sweepTemp = false } = {}) {
  /** @type {string[]} */
  const ids = [];
  let shards;
  try { shards = await fs.readdir(path.join(dir, 'raw')); } catch { return ids; }
  for (const s of shards) {
    let files;
    try { files = await fs.readdir(path.join(dir, 'raw', s)); } catch { continue; }
    for (const f of files) {
      if (f.includes(TMP_MARK)) { if (sweepTemp) await fs.rm(path.join(dir, 'raw', s, f), { force: true }); continue; }
      const id = f.endsWith('.eml') ? f.slice(0, -4) : '';
      if (RECORD_ID_RE.test(id) && id.startsWith(s)) ids.push(id);
    }
  }
  return ids;
}

/** @param {MpRecord | null} rec @returns {string[]} The attachment hexes a record lists. */
function attachmentHexes(rec) {
  if (!rec || !Array.isArray(rec.attachments)) return [];
  return rec.attachments.map((a) => (a && typeof a.sha256 === 'string' ? a.sha256.replace(/^sha256:/, '') : '')).filter((h) => SHA_HEX_RE.test(h));
}

/** @typedef {<T>(work: () => Promise<T>) => Promise<T>} WithLock  Runs `work` under the trail lock (mailproof.js supplies it). */
/** @typedef {{ afterScan?: () => Promise<void> }} ScanHooks  Test seam: called after the unlocked scan, before the lock is taken. */

/**
 * What the unlocked scan saw: the trail HEAD it started at, and the ids that had a stored raw email then.
 * @typedef {{ head: string | null, stored: Set<string> }} Scan
 */

/**
 * Attachment hexes referenced by the records of the stored emails (minus `exclude`), read WITHOUT the trail lock.
 * This is the dedup scan: one record JSON read per stored raw (F22). Read-only.
 * @param {string} root
 * @param {string} dir
 * @param {Set<string>} [exclude]  Ids not to count (the ones about to be forgotten).
 * @returns {Promise<{ scan: Scan, kept: Set<string> }>}
 */
async function scanReferenced(root, dir, exclude = new Set()) {
  const head = await headOf(root);
  const stored = new Set(await storedIds(dir));
  /** @type {Set<string>} */
  const kept = new Set();
  for (const id of stored) if (!exclude.has(id)) for (const h of attachmentHexes(await readRecord(root, id))) kept.add(h);
  return { scan: { head, stored }, kept };
}

/**
 * Under the trail lock, bring an unlocked scan up to date: add to `kept` the attachments of every record whose raw
 * email is stored now but was not when the scan began (committed since, backfilled since) or that was committed
 * since the scan's HEAD with a stored raw. Also clears stray temp files. Cost: one directory listing plus a record
 * read per NEW stored email, not per stored email.
 * @param {string} root
 * @param {string} dir
 * @param {Scan} scan
 * @param {Set<string>} kept  Mutated.
 * @returns {Promise<boolean>}  False when the trail was rewritten under the scan (HEAD is not a descendant of the scan's): the scan means nothing, do not delete.
 */
async function revalidate(root, dir, scan, kept) {
  const head = await headOf(root);
  if (scan.head !== head) {
    if (scan.head === null) { /* the trail was empty at scan time: everything is new, found by the listing below */ }
    else if (head === null || !(await isAncestor(root, scan.head, head))) return false;
    else {
      for (const id of await recordIdsSince(root, scan.head)) {
        if (await exists(rawPathOf(dir, id))) for (const h of attachmentHexes(await readRecord(root, id))) kept.add(h);
      }
    }
  }
  for (const id of await storedIds(dir, { sweepTemp: true })) {
    if (!scan.stored.has(id)) for (const h of attachmentHexes(await readRecord(root, id))) kept.add(h);
  }
  return true;
}

/** @param {string} dir @returns {Promise<string[]>} Every attachment hex that has a file (temp files excluded). */
async function attachmentFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const base = path.join(dir, 'att');
  let shards;
  try { shards = await fs.readdir(base); } catch { return out; }
  for (const s of shards) {
    let names;
    try { names = await fs.readdir(path.join(base, s)); } catch { continue; }
    for (const f of names) if (SHA_HEX_RE.test(f)) out.push(f);
  }
  return out;
}

/**
 * Delete the attachment files of `hexes`.
 * @param {string} dir
 * @param {Iterable<string>} hexes
 * @returns {Promise<number>}  Files deleted.
 */
async function unlinkAttachments(dir, hexes) {
  let n = 0;
  for (const h of hexes) {
    try { await fs.unlink(attPathOf(dir, h)); n++; } catch { /* already gone */ }
  }
  return n;
}

/**
 * Delete content whose retention has run out: raw emails captured more than `days` days before `nowMs`, then the
 * attachment files no stored raw references any more. Content only; records are never touched. A record that
 * cannot be read or has no usable `captured` is kept (never delete on doubt).
 *
 * Two phases. (1) A read-only scan with NO lock: record the trail HEAD, read every stored email's record, decide
 * what is expired and which attachment files are unreferenced. Writers (record, sync) carry on meanwhile. (2) Under
 * the trail lock, only the deletions: revalidate the scan against what changed since its HEAD (revalidate), re-check
 * each expired email once more, then unlink. If the trail was rewritten under the scan, nothing is deleted this round.
 * @param {string} root
 * @param {string} dir
 * @param {number} days
 * @param {number} nowMs
 * @param {WithLock} withLock
 * @param {ScanHooks} [hooks]
 * @returns {Promise<{ removed: number, attachments: number }>}
 */
async function expireStore(root, dir, days, nowMs, withLock, hooks = {}) {
  const cutoff = nowMs - days * DAY_MS;
  /** @param {MpRecord | null} rec */
  const isExpired = (rec) => { const at = rec ? Date.parse(rec.captured) : NaN; return rec !== null && Number.isFinite(at) && at < cutoff; };
  const head = await headOf(root);
  const stored = new Set(await storedIds(dir));
  /** @type {Set<string>} */
  const kept = new Set();
  /** @type {string[]} */
  const expired = [];
  for (const id of stored) {
    const rec = await readRecord(root, id);
    if (isExpired(rec)) expired.push(id);
    else for (const h of attachmentHexes(rec)) kept.add(h);
  }
  const candidates = (await attachmentFiles(dir)).filter((h) => !kept.has(h));
  await hooks.afterScan?.();
  return withLock(async () => {
    if (!(await revalidate(root, dir, { head, stored }, kept))) return { removed: 0, attachments: 0 };
    let removed = 0;
    for (const id of expired) {
      const rec = await readRecord(root, id);
      if (!isExpired(rec)) { for (const h of attachmentHexes(rec)) kept.add(h); continue; }
      try { await fs.unlink(rawPathOf(dir, id)); removed++; } catch { /* already gone */ }
    }
    return { removed, attachments: await unlinkAttachments(dir, candidates.filter((h) => !kept.has(h))) };
  });
}

/**
 * Delete the stored raw email of each id, then the attachment files only they referenced. The dedup scan runs with
 * no lock; the lock is held for the deletions (see expireStore). If the trail was rewritten under the scan, the scan
 * is redone under the lock (a forget the caller asked for is never skipped).
 * @param {string} root
 * @param {string} dir
 * @param {Iterable<string>} ids  Record ids (32 hex).
 * @param {WithLock} withLock
 * @param {ScanHooks} [hooks]
 * @returns {Promise<{ removed: number, attachments: number }>}
 */
async function forgetIds(root, dir, ids, withLock, hooks = {}) {
  const want = new Set(ids);
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const id of want) {
    if (!(await exists(rawPathOf(dir, id)))) continue;
    for (const h of attachmentHexes(await readRecord(root, id))) candidates.add(h);
  }
  const pre = candidates.size ? await scanReferenced(root, dir, want) : null;
  await hooks.afterScan?.();
  return withLock(async () => {
    /** @type {Set<string>} */
    let kept = new Set();
    if (pre) {
      kept = pre.kept;
      if (!(await revalidate(root, dir, pre.scan, kept))) kept = (await scanReferenced(root, dir, want)).kept;
    }
    let removed = 0;
    for (const id of want) {
      try { await fs.unlink(rawPathOf(dir, id)); removed++; } catch { /* not stored, or gone */ }
    }
    return { removed, attachments: await unlinkAttachments(dir, [...candidates].filter((h) => !kept.has(h))) };
  });
}

/**
 * Lower-cased addresses on the From/To/Cc lines of the signed headers of a record (any signature), plus the
 * `message.from` of an unsigned record.
 * @param {MpRecord} rec
 * @returns {Set<string>}
 */
function participantsOfRecord(rec) {
  /** @type {Set<string>} */
  const out = new Set();
  try {
    for (const sig of Array.isArray(rec.signatures) ? rec.signatures : []) {
      for (const l of Array.isArray(sig.signed_headers) ? sig.signed_headers : []) {
        const line = Buffer.from(l, 'base64').toString('binary');
        const m = /^(from|to|cc)[ \t]*:/i.exec(line);
        if (m) for (const a of extractAddresses(line.slice(m[0].length))) out.add(a.toLowerCase());
      }
    }
    const from = rec.message?.from;
    if (typeof from === 'string') out.add(from.toLowerCase());
  } catch { /* a malformed record has no participants */ }
  return out;
}

/**
 * Lower-cased addresses on the From/To/Cc lines of a raw email's header block (signed or not).
 * @param {Buffer} head  The start of the raw bytes (the header block is at most MAX_HEADER_BYTES).
 * @returns {Set<string>}
 */
function participantsOfRaw(head) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const r of splitMessage(head).rows) {
    if (r.name !== 'from' && r.name !== 'to' && r.name !== 'cc') continue;
    for (const a of extractAddresses(r.raw.slice(r.raw.indexOf(':') + 1))) out.add(a.toLowerCase());
  }
  return out;
}

/**
 * The stored ids whose counterparty is `address` (exact, case-insensitive) and whose capture time is in range.
 * @param {string} root
 * @param {string} dir
 * @param {{ with: string, before?: Date | string | number, after?: Date | string | number }} q
 * @returns {Promise<string[]>}
 */
async function idsWith(root, dir, q) {
  const want = q.with.trim().toLowerCase();
  const before = q.before === undefined ? Infinity : toMs(q.before, 'before');
  const after = q.after === undefined ? -Infinity : toMs(q.after, 'after');
  /** @type {string[]} */
  const hit = [];
  for (const id of await storedIds(dir)) {
    const rec = await readRecord(root, id);
    if (!rec) continue;
    const at = Date.parse(rec.captured);
    if (!Number.isFinite(at) || at < after || at >= before) continue;
    let match = participantsOfRecord(rec).has(want);
    if (!match) {
      let head = null;
      try {
        const fh = await fs.open(rawPathOf(dir, id), 'r');
        try {
          const b = Buffer.alloc(MAX_HEADER_BYTES);
          const { bytesRead } = await fh.read(b, 0, b.length, 0);
          head = b.subarray(0, bytesRead);
        } finally { await fh.close(); }
      } catch { /* gone meanwhile */ }
      match = head !== null && participantsOfRaw(head).has(want);
    }
    if (match) hit.push(id);
  }
  return hit;
}

/** @param {unknown} v @param {string} what @returns {number} */
function toMs(v, what) {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`forget: ${what} must be a Date, a timestamp or an ISO date string`);
  return ms;
}

export {
  DAY_MS, parseContentOptions, contentDirOf, rawPathOf, attPathOf, sha256Of, storeContent, readRaw, readAttachment,
  storedIds, expireStore, forgetIds, idsWith, toMs, exists,
};
