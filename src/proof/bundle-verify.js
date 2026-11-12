// `verifyBundle` (SPEC B13.3): check a pair bundle (B13.2) on the recipient's machine, with nothing of the owner's: no trail, no index,
// no content store, no account, no network. The bundle is hostile input (its sender may be an adversary), so every bound is checked
// from `lstat` before any read, nothing is followed or joined from a name the bundle gives, and `ots` is only ever asked to PARSE a
// proof (`ots info`): never `ots upgrade` or `ots verify`, which query calendars live.
//
// One source of truth: records go through `verifyRecord`, manifests through `parseManifest`, seals through `decideSeal` (the
// function `findSeal` and `export` use), paths through `layout.js`, `ots info` through `ots.js`, "who a record names" through
// `participantsOf`. This module imports nothing of the trail, git, the index or the content store. It writes nothing anywhere.

import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBundlePath, parseKeyPath, recordPath, recordOtsPath, manifestOtsPath, replyPath, BUNDLE_JSON } from './layout.js';
import { parseManifest, decideSeal, sha256Hex } from './seal-core.js';
import { verifyRecord } from './recheck.js';
import { participantsOf, signedHeaderValue, addressCoverage } from './participants.js';
import { headerText } from './header-text.js';
import { infoProof } from './ots.js';
import { RULES_VERSION } from './verdict.js';
import * as LIM from './limits.js';
import { unpackTar } from './bundle-tar.js';

/** @typedef {{ state: 'anchored' | 'pending' | 'unstamped' | 'unsealed' | 'unchecked' | 'bad', via: 'record' | 'manifest' | null, listed_in: number | null, stamped_by: number | null, sealed_at: string | null, block?: number, merkle_root?: string, why?: string }} BundleSeal */

/**
 * @typedef {Object} BundleResult
 * @property {boolean} ok  True when no check failed (with `strict`, also when every record is verified and every seal anchored).
 * @property {string[]} failed  The failed check names, in the order of SPEC B13.3.3 (`strict:verified` and `strict:anchored` last).
 * @property {{ v: number, kind: string, created: string | null, mailproof: string | null, trail: string | null, trail_head: string | null, selection: { with: string[], after: string | null, before: string | null, records: number | null }, bundle_sha256: string } | null} bundle  Null when `bundle.json` is missing or failed its own check.
 * @property {{ given: string, match: boolean } | null} expect
 * @property {{ listed: number, found: number, bytes: number, problems: Array<{ path: string, why: string }> }} files
 * @property {Array<{ id: string, captured: string | null, direction: string | null, from: string | null, to: string | null, subject: string | null, subject_signed: boolean, ok: boolean, trust: 'verified' | 'unverified', at: string | null, signatures: Array<Record<string, any>>, key: 'ok' | 'none' | 'mismatch' | 'missing', seal: BundleSeal, replies: Array<{ slug: string, seal: BundleSeal }>, notes: string[], problems: string[] }>} records
 * @property {{ runs: Array<{ from: number, to: number }>, problems: Array<{ seq: number, why: string }> }} chain
 * @property {'used' | 'absent' | 'off' | 'out of time'} ots  What happened to the proofs.
 * @property {{ records: number, verified: number, unverified: number, anchored: number, pending: number, unstamped: number, unsealed: number, unchecked: number, bad: number }} counts  Seal counts are over the records.
 * @property {Array<{ check: string, id: string | null, why: string }>} problems  Every failure, with the check it belongs to (additive to the SPEC shape: text mode prints it).
 */

const CHECKS = ['bundle.json', 'expect', 'files', 'records', 'selection', 'keys', 'replies', 'chain', 'seals'];
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SLUG = /^[a-z0-9-]+$/;
const MAX_DEPTH = 3;   // records/<2hex>/<file>: two directories under the root

/** The bounds (SPEC B13.2.8). `opts._limits` lowers them for tests. */
const DEFAULT_LIMITS = {
  BUNDLE_MAX_FILES: LIM.BUNDLE_MAX_FILES, BUNDLE_MAX_BYTES: LIM.BUNDLE_MAX_BYTES, BUNDLE_MAX_RECORD_BYTES: LIM.BUNDLE_MAX_RECORD_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES: LIM.BUNDLE_MAX_MANIFEST_BYTES, BUNDLE_MAX_OTS_BYTES: LIM.BUNDLE_MAX_OTS_BYTES, BUNDLE_MAX_SMALL_BYTES: LIM.BUNDLE_MAX_SMALL_BYTES,
  BUNDLE_MAX_JSON_BYTES: LIM.BUNDLE_MAX_JSON_BYTES, BUNDLE_MAX_README_BYTES: LIM.BUNDLE_MAX_README_BYTES, BUNDLE_OTS_TIMEOUT_MS: LIM.BUNDLE_OTS_TIMEOUT_MS,
  BUNDLE_OTS_MAX_MS: LIM.BUNDLE_OTS_MAX_MS, BUNDLE_OTS_OUTPUT_BYTES: LIM.BUNDLE_OTS_OUTPUT_BYTES, EXPORT_MAX_RECORDS: LIM.EXPORT_MAX_RECORDS,
};
/** @typedef {typeof DEFAULT_LIMITS} Limits */

/** @param {NonNullable<ReturnType<typeof parseBundlePath>>} c @param {Limits} L @returns {number} */
function capOf(c, L) {
  switch (c.kind) {
    case 'record': return c.ots ? L.BUNDLE_MAX_OTS_BYTES : L.BUNDLE_MAX_RECORD_BYTES;
    case 'manifest': return c.ots ? L.BUNDLE_MAX_OTS_BYTES : L.BUNDLE_MAX_MANIFEST_BYTES;
    case 'reply': case 'key': return L.BUNDLE_MAX_SMALL_BYTES;
    case 'bundle': return L.BUNDLE_MAX_JSON_BYTES;
    default: return L.BUNDLE_MAX_README_BYTES;
  }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read one file of the bundle without ever blocking or following a link: opened `O_NOFOLLOW | O_NONBLOCK` (a FIFO swapped in
 * after the walk does not hang the open), checked with `fstat` to be a regular file within `cap`, and read at most `cap + 1` bytes.
 * @param {string} abs
 * @param {number} cap
 * @returns {Promise<Buffer | string>}  The bytes, or the reason it was not read.
 */
async function readCapped(abs, cap) {
  /** @type {import('node:fs/promises').FileHandle | null} */
  let h = null;
  try {
    h = await fs.open(abs, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    const st = await h.stat();
    if (!st.isFile()) return 'unsafe entry (not a regular file)';
    if (st.size > cap) return `over its size limit (${cap} bytes)`;
    const buf = Buffer.alloc(Math.min(st.size, cap) + 1);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    if (bytesRead > cap) return `over its size limit (${cap} bytes)`;
    return buf.subarray(0, bytesRead);
  } catch (e) {
    return `cannot be read (${/** @type {any} */ (e)?.code ?? 'error'})`;
  } finally { await h?.close().catch(() => {}); }
}

/**
 * `lstat`-based walk: only regular files and directories are accepted; a symlink, device, FIFO or socket is a problem and is never
 * followed or opened. Counts and bytes are tallied as it goes and the walk stops at the first limit.
 * @param {string} root
 * @param {Limits} L
 * @returns {Promise<{ files: Map<string, number>, problems: Array<{ path: string, why: string }>, bytes: number, refused: boolean }>}
 */
async function walk(root, L) {
  /** @type {Map<string, number>} */
  const files = new Map();
  /** @type {Array<{ path: string, why: string }>} */
  const problems = [];
  let bytes = 0;
  let count = 0;
  let refused = false;
  /** @param {string} abs @param {string} rel @param {number} depth @returns {Promise<void>} */
  async function dir(abs, rel, depth) {
    /** @type {import('node:fs').Dirent[]} */
    let ents;
    try { ents = await fs.readdir(abs, { withFileTypes: true }); } catch { problems.push({ path: rel || '.', why: 'directory cannot be read' }); return; }
    for (const e of ents) {
      if (refused) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (++count > L.BUNDLE_MAX_FILES) { refused = true; problems.push({ path: r, why: `more than ${L.BUNDLE_MAX_FILES} entries: the bundle is refused unread` }); return; }
      if (e.isSymbolicLink()) { problems.push({ path: r, why: 'unsafe entry (symlink)' }); continue; }
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH) { problems.push({ path: r, why: 'unexpected path' }); continue; }
        await dir(path.join(abs, e.name), r, depth + 1);
        continue;
      }
      if (!e.isFile()) { problems.push({ path: r, why: 'unsafe entry (not a regular file)' }); continue; }
      let size = 0;
      try { size = (await fs.lstat(path.join(abs, e.name))).size; } catch { problems.push({ path: r, why: 'cannot be read (lstat failed)' }); continue; }
      bytes += size;
      if (bytes > L.BUNDLE_MAX_BYTES) { refused = true; problems.push({ path: r, why: `the bundle is over ${L.BUNDLE_MAX_BYTES} bytes: refused unread` }); return; }
      files.set(r, size);
    }
  }
  await dir(root, '', 0);
  return { files, problems, bytes, refused };
}

/**
 * Per-manifest lookup of (id | id.slug) -> file hash, built once: `lists` is asked for every record and reply of the bundle.
 * @param {import('./seal-core.js').Manifest} m
 * @param {WeakMap<object, Map<string, string>>} cache
 * @returns {Map<string, string>}
 */
function entriesOf(m, cache) {
  let x = cache.get(m);
  if (!x) {
    x = new Map();
    for (const e of m.records) x.set(e[0], e[1]);
    for (const e of m.replies) x.set(`${e[0]}.${e[1]}`, e[2]);
    cache.set(m, x);
  }
  return x;
}

/** @returns {BundleSeal} */
const sealOf = (/** @type {BundleSeal['state']} */ state, /** @type {Partial<BundleSeal>} */ more = {}) => ({ state, via: null, listed_in: null, stamped_by: null, sealed_at: null, ...more });

/** @mcp verifyBundle Check a pair bundle someone made with `export`: pass `dir`, the bundle's folder or the `.tar` file `export` writes, which must be inside one of the server's input folders. Offline: it re-checks every record's signature against its archived key, the file hashes, the manifest chain and each seal (locally, with `ots info`), and reports `ok`, the `failed` checks and one line per record. Pass `expect` (the 64-hex `bundle_sha256` the sender gave you another way) to pin the bundle; `strict` also fails unless every record is verified and every seal anchored. A bad bundle is `ok: false`, not an error. It does not prove completeness: the sender chose the emails. */
/**
 * Check a pair bundle (SPEC B13.3). Resolves to a result for every directory that can be examined, never rejecting for a bad
 * bundle; a bad argument is a `TypeError`.
 * @param {string} dir  The bundle directory (a real directory, not a symlink), or the `.tar` file `export` writes: it is unpacked by a bounded reader into a private temp folder that is removed afterwards (a link, device, `..` or absolute entry refuses the tar).
 * @param {{ ots?: string | null, expect?: string, strict?: boolean, _limits?: Partial<Limits> }} [opts]  `ots`: the OpenTimestamps binary (default `ots` from PATH; `null`: do not run it, the seals are reported `unchecked`). `expect`: the 64-hex `bundle_sha256` the owner told you by another channel. `strict`: also fail unless every record is `verified` and every seal `anchored`. (`_limits` is a test seam.)
 * @returns {Promise<BundleResult>}
 * @name verifyBundle
 * @when Use on the recipient's side to check a pair bundle made by `mp.export()` with no trail, index, content store, account or network: it re-checks every record's DKIM signature offline from the record and its archived key, that the files are the ones the bundle lists, the manifest chain and each OpenTimestamps seal (`ots info`, local). `anchored` means the proof is for these bytes and carries a Bitcoin block attestation; the block header is NOT checked against Bitcoin (run `ots verify` for that). It never proves completeness: the owner chose what is in the bundle.
 * @category verify
 * @signature verifyBundle(dir: string, opts?: { ots?: string|null, expect?: string, strict?: boolean }) => Promise<{ ok, failed[], bundle, expect, files, records[], chain, ots, counts }>
 * @fails Resolves for every bundle it can examine (a missing, damaged, tampered or hostile bundle is `ok: false` with the failed checks named, never a rejection); rejects with a `TypeError` for a `dir` that is not a string or not an existing directory, or a bad `expect`/`opts`. Writes nothing; never runs `ots upgrade` or `ots verify`; no network.
 * @example
 * import { verifyBundle } from 'mailproof';
 * const r = await verifyBundle('./bundle-from-alice', { expect: bundleSha256 });   // r.ok, r.failed, r.records[0].seal
 */
async function verifyBundle(dir, opts = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('verifyBundle: dir must be a path string');
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('verifyBundle: opts must be an object');
  if (opts.ots !== undefined && opts.ots !== null && (typeof opts.ots !== 'string' || !opts.ots)) throw new TypeError('verifyBundle: ots must be a binary path or null');
  if (opts.expect !== undefined && !(typeof opts.expect === 'string' && HEX64.test(opts.expect.toLowerCase()))) throw new TypeError('verifyBundle: expect must be 64 hex characters');
  if (opts.strict !== undefined && typeof opts.strict !== 'boolean') throw new TypeError('verifyBundle: strict must be a boolean');
  /** @type {Limits} */
  const L = { ...DEFAULT_LIMITS, ...(opts._limits ?? {}) };
  const root = path.resolve(dir);
  const st = await fs.lstat(root).catch(() => null);
  if (!st) throw new TypeError(`verifyBundle: ${dir} does not exist`);
  if (st.isFile() && root.endsWith('.tar')) return verifyTar(root, opts, L);
  if (!st.isDirectory() && !st.isSymbolicLink()) throw new TypeError(`verifyBundle: ${dir} is not a directory or a .tar file`);
  return verifyDir(root, st, opts, L, []);
}

/**
 * A `.tar` bundle (SPEC B13.3.10): unpacked by our own bounded reader into a private temp directory, checked like a folder, and removed
 * again. A tar that is refused reads as a bundle with a `files` failure that says why.
 * @param {string} file @param {Parameters<typeof verifyBundle>[1] & {}} opts @param {Limits} L @returns {Promise<BundleResult>}
 */
async function verifyTar(file, opts, L) {
  const u = await unpackTar(file, { maxFiles: L.BUNDLE_MAX_FILES, maxBytes: L.BUNDLE_MAX_BYTES });
  const empty = 'problems' in u ? await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-vb-')) : null;
  try {
    const dir = 'problems' in u ? /** @type {string} */ (empty) : u.dir;
    return await verifyDir(dir, await fs.lstat(dir), opts, L, 'problems' in u ? u.problems : []);
  } finally {
    await u.cleanup();
    if (empty) await fs.rm(empty, { recursive: true, force: true });
  }
}

/**
 * @param {string} root @param {import('node:fs').Stats} st @param {Parameters<typeof verifyBundle>[1] & {}} opts @param {Limits} L
 * @param {string[]} pre  Problems found before the walk (a refused tar).
 * @returns {Promise<BundleResult>}
 */
async function verifyDir(root, st, opts, L, pre) {

  /** @type {Set<string>} */
  const failedSet = new Set();
  /** @type {BundleResult['problems']} */
  const problems = [];
  /** @type {Map<string, BundleResult['records'][number]>} */
  const recById = new Map();
  /** @param {string} check @param {string | null} id @param {string} why */
  const fail = (check, id, why) => {
    failedSet.add(check);
    problems.push({ check, id, why });
    const r = id ? recById.get(id) : undefined;
    if (r) { r.ok = false; r.problems.push(`${check}: ${why}`); }
  };
  /** @type {BundleResult} */
  const result = {
    ok: false, failed: [], bundle: null, expect: null,
    files: { listed: 0, found: 0, bytes: 0, problems: [] },
    records: [], chain: { runs: [], problems: [] }, ots: 'used',
    counts: { records: 0, verified: 0, unverified: 0, anchored: 0, pending: 0, unstamped: 0, unsealed: 0, unchecked: 0, bad: 0 },
    problems,
  };
  for (const why of pre) { result.files.problems.push({ path: '.', why }); fail('files', null, why); }
  const finish = () => {
    result.failed = [...CHECKS.filter((c) => failedSet.has(c)), ...['strict:verified', 'strict:anchored'].filter((c) => failedSet.has(c))];
    result.ok = result.failed.length === 0;
    return result;
  };

  if (st.isSymbolicLink()) { result.files.problems.push({ path: '.', why: 'unsafe entry (the bundle directory is a symlink)' }); fail('files', null, 'the bundle directory is a symlink'); return finish(); }

  // ---- the walk: lstat only, counts and sizes before any read ----
  const w = await walk(root, L);
  result.files.found = w.files.size;
  result.files.bytes = w.bytes;
  for (const p of w.problems) { result.files.problems.push(p); fail('files', null, `${p.path}: ${p.why}`); }
  if (w.refused) return finish();
  /** @type {Map<string, NonNullable<ReturnType<typeof parseBundlePath>>>} */
  const kinds = new Map();
  for (const rel of [...w.files.keys()].sort()) {
    const c = parseBundlePath(rel);
    if (!c) { result.files.problems.push({ path: rel, why: 'unexpected path' }); fail('files', null, `${rel}: unexpected path`); continue; }
    kinds.set(rel, c);
  }

  // ---- 1. bundle.json ----
  /** @type {Buffer | null} */
  let bundleBytes = null;
  /** @type {any} */
  let bj = null;
  let bundleOk = false;
  if (kinds.has(BUNDLE_JSON)) {
    const r = await readCapped(path.join(root, BUNDLE_JSON), L.BUNDLE_MAX_JSON_BYTES);
    if (typeof r === 'string') fail('bundle.json', null, `bundle.json ${r}`);
    else {
      bundleBytes = r;
      try { bj = JSON.parse(r.toString('utf8')); } catch { fail('bundle.json', null, 'bundle.json does not parse'); }
    }
  } else fail('bundle.json', null, 'bundle.json is missing');
  /** @type {Map<string, any>} */
  const entries = new Map();
  if (bj !== null) {
    const bad = (/** @type {string} */ why) => { fail('bundle.json', null, why); };
    if (!isObj(bj)) bad('bundle.json is not an object');
    else if (bj.v !== 1) bad(`unsupported bundle version ${typeof bj.v === 'number' || typeof bj.v === 'string' ? String(bj.v).slice(0, 20) : '?'}: upgrade mailproof`);
    else if (bj.kind !== 'mailproof-pair-bundle') bad('kind is not mailproof-pair-bundle');
    else if (!Array.isArray(bj.records) || bj.records.length === 0) bad('records must be a non-empty list');
    else if (bj.records.length > L.EXPORT_MAX_RECORDS) bad(`more than ${L.EXPORT_MAX_RECORDS} records`);
    else if (!isObj(bj.files) || !Object.values(bj.files).every((h) => typeof h === 'string' && HEX64.test(h))) bad('files must map paths to sha256 hex');
    else if (!isObj(bj.selection) || !Array.isArray(bj.selection.with) || !bj.selection.with.length || bj.selection.with.length > LIM.EXPORT_MAX_ADDRESSES
      || !bj.selection.with.every((/** @type {unknown} */ a) => typeof a === 'string' && a) || ![bj.selection.after, bj.selection.before].every((/** @type {unknown} */ t) => t === null || (typeof t === 'string' && Number.isFinite(Date.parse(t))))) bad('selection is malformed');
    else {
      let good = true;
      for (const e of bj.records) {
        const okEntry = isObj(e) && typeof e.id === 'string' && HEX32.test(e.id) && !entries.has(e.id) && typeof e.file === 'string'
          && typeof e.captured === 'string' && (e.direction === 'in' || e.direction === 'out') && typeof e.portable === 'string'
          && (e.replies === undefined || (Array.isArray(e.replies) && e.replies.every((/** @type {unknown} */ s) => typeof s === 'string' && SLUG.test(s))));
        if (!okEntry) { bad(`a records entry is malformed, or its id is not 32 lowercase hex and unique${isObj(e) && typeof e.id === 'string' ? ` (${e.id.slice(0, 40)})` : ''}`); good = false; break; }
        entries.set(e.id, e);
      }
      bundleOk = good;
    }
  }
  const sel = bundleOk ? { with: /** @type {string[]} */ (bj.selection.with).map((a) => a.toLowerCase()), after: /** @type {string | null} */ (bj.selection.after), before: /** @type {string | null} */ (bj.selection.before), records: typeof bj.selection.records === 'number' ? bj.selection.records : null } : null;
  const bundleSha = bundleBytes ? sha256Hex(bundleBytes) : null;
  if (bundleOk && bundleSha && sel) {
    const s = (/** @type {unknown} */ x) => (typeof x === 'string' ? x : null);
    result.bundle = { v: 1, kind: 'mailproof-pair-bundle', created: s(bj.created), mailproof: s(bj.mailproof), trail: s(bj.trail), trail_head: s(bj.trail_head), selection: sel, bundle_sha256: bundleSha };
  }

  // ---- 2. expect ----
  if (opts.expect !== undefined) {
    const given = opts.expect.toLowerCase();
    const match = bundleSha === given;
    result.expect = { given, match };
    if (!match) fail('expect', null, bundleSha ? 'the sha256 of bundle.json is not the one given' : 'bundle.json could not be read, so it cannot match');
  }

  // ---- read every file once: hash it; keep the small ones, check the records as they come ----
  /** @type {Map<string, string>} */
  const hashes = new Map();
  /** @type {Map<string, Buffer>} */
  const bytesOf = new Map();
  /** @type {Map<string, { rec: any, verdict: ReturnType<typeof verifyRecord> | null, sigs: any[] }>} */
  const recData = new Map();
  /** @type {Map<string, { id: string, slug: string, json: any }>} */
  const replyData = new Map();
  for (const [rel, c] of kinds) {
    const r = await readCapped(path.join(root, rel), capOf(c, L));
    if (typeof r === 'string') { result.files.problems.push({ path: rel, why: r }); fail('files', null, `${rel}: ${r}`); continue; }
    hashes.set(rel, sha256Hex(r));
    if (c.kind === 'bundle') continue;
    if (c.kind === 'record' && !c.ots) {
      if (bundleOk) recData.set(c.id, { rec: tryJson(r), verdict: null, sigs: [] });
      continue;
    }
    if (c.kind === 'manifest' && !c.ots) bytesOf.set(rel, r);
    else if (c.kind === 'key' || c.kind === 'reply') bytesOf.set(rel, r);
    else continue;
  }
  result.files.listed = bj && isObj(bj.files) ? Object.keys(bj.files).length : 0;

  // ---- 3. files ----
  if (bundleOk) {
    const listed = /** @type {Record<string, string>} */ (bj.files);
    for (const [p, h] of Object.entries(listed)) {
      if (p === BUNDLE_JSON || !parseBundlePath(p)) { result.files.problems.push({ path: p.slice(0, 200), why: 'unexpected path' }); fail('files', null, `${p.slice(0, 200)}: unexpected path`); continue; }
      const got = hashes.get(p);
      if (!kinds.has(p)) { result.files.problems.push({ path: p, why: 'missing' }); fail('files', null, `${p}: missing`); }
      else if (got !== undefined && got !== h) { result.files.problems.push({ path: p, why: 'sha256 differs from the listed one' }); fail('files', null, `${p}: sha256 differs from the listed one`); }
    }
    for (const p of kinds.keys()) {
      if (p !== BUNDLE_JSON && !Object.hasOwn(listed, p)) { result.files.problems.push({ path: p, why: 'not listed' }); fail('files', null, `${p}: not listed in bundle.json`); }
    }
  }

  // ---- 4. records (and 5. selection, 6. keys, per record) ----
  /** @type {Array<{ id: string, entry: any }>} */
  const order = bundleOk ? [...entries.entries()].map(([id, entry]) => ({ id, entry })) : [];
  for (const { id, entry } of order) {
    /** @type {BundleResult['records'][number]} */
    const out = { id, captured: entry.captured, direction: entry.direction, from: null, to: null, subject: null, subject_signed: false, ok: true, trust: 'unverified', at: null, signatures: [], key: 'none', seal: sealOf('unsealed'), replies: [], notes: [], problems: [] };
    result.records.push(out);
    recById.set(id, out);
    const want = recordPath(id);
    if (entry.file !== want) fail('records', id, `file is ${String(entry.file).slice(0, 120)}, not ${want}`);
    const d = recData.get(id);
    if (!d || !kinds.has(want)) { fail('records', id, 'the record file is missing'); continue; }
    if (!isObj(d.rec)) { fail('records', id, 'the record does not parse'); continue; }
    const rec = /** @type {import('./types.js').MpRecord} */ (/** @type {unknown} */ (d.rec));
    if (rec.v !== 2) { fail('records', id, 'the record is not version 2'); continue; }
    if (rec.id !== id) fail('records', id, 'the record id is not its file name');
    const raw = isObj(rec.message) && typeof rec.message.raw_sha256 === 'string' ? rec.message.raw_sha256.replace(/^sha256:/, '') : '';
    if (!HEX64.test(raw) || !raw.startsWith(id)) fail('records', id, 'message.raw_sha256 does not start with the id');
    if (rec.captured !== entry.captured) fail('records', id, 'captured differs from the bundle entry');
    if (rec.direction !== entry.direction) fail('records', id, 'direction differs from the bundle entry');
    const sigs = Array.isArray(rec.signatures) ? rec.signatures : [];
    d.sigs = sigs;
    if (sigs.length > LIM.MAX_SIGNATURES) { fail('records', id, `more than ${LIM.MAX_SIGNATURES} signatures: not re-checked`); continue; }
    const v = verifyRecord(rec);
    d.verdict = v;
    out.trust = v.trust;
    out.at = v.at;
    out.signatures = v.signatures;
    // who and what, for a row: data from the record (the addresses field or the signed h= lines), never a claim of the raw email (the bundle has none)
    const parts = participantsOf(rec);
    const first = (/** @type {string} */ role) => parts.find((x) => x.role === role)?.raw ?? null;
    out.from = first('from');
    out.to = first('to') ?? first('cc');
    const signedSubject = v.passing.length ? signedHeaderValue(rec, 'subject', v.passing) : null;
    const anySubject = signedSubject ?? signedHeaderValue(rec, 'subject');
    out.subject = anySubject === null ? null : headerText(anySubject);
    out.subject_signed = signedSubject !== null;
    const recorded = isObj(rec.verdicts) && isObj(rec.verdicts.portable) ? rec.verdicts.portable.trust : undefined;
    if (recorded !== entry.portable) fail('records', id, `the record says portable ${String(recorded)}, the bundle entry says ${String(entry.portable).slice(0, 40)}`);
    if (recorded === 'verified' && v.trust !== 'verified') fail('records', id, 'the record says portable verified but its signatures do not verify');
    else if (recorded !== 'verified' && v.trust === 'verified') out.notes.push('verdict improved: recorded unverified, recomputes verified');
    const rules = isObj(rec.verdicts) && isObj(rec.verdicts.portable) && isObj(rec.verdicts.portable.engine) ? rec.verdicts.portable.engine.rules : undefined;
    if (typeof rules === 'string' && rules !== RULES_VERSION) out.notes.push(`recorded with rules ${rules.slice(0, 40)}, this build is ${RULES_VERSION}`);

    // 5. selection
    if (sel) {
      const names = participantsOf(rec).map((p) => p.address);
      if (!names.some((a) => sel.with.includes(a))) fail('selection', id, 'the record names none of the selected addresses');
      const ms = Date.parse(String(rec.captured));
      if (!Number.isFinite(ms) || (sel.after !== null && ms < Date.parse(sel.after)) || (sel.before !== null && ms >= Date.parse(sel.before))) fail('selection', id, 'captured is outside the selected range');
    }

    // 6. keys
    let keyed = false;
    /** @type {'ok' | 'mismatch' | 'missing'} */
    let kstate = 'ok';
    sigs.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      if (!isObj(s) || typeof s.key_file !== 'string') return;
      keyed = true;
      const kf = s.key_file;
      const parsed = parseKeyPath(kf);
      const sv = v.signatures[i];
      const p = isObj(s.key) && typeof s.key.p === 'string' ? s.key.p : null;
      if (!parsed || !sv || !p || sv.d === null || sv.s === null || parsed.domain !== sv.d.toLowerCase() || parsed.selector !== sv.s.toLowerCase() || parsed.h16 !== sha256Hex(p).slice(0, 16)) {
        kstate = 'mismatch'; fail('keys', id, `signature ${i}: key_file ${kf.slice(0, 120)} is not the path of its domain, selector and key`); return;
      }
      const kb = bytesOf.get(kf);
      if (!kb) { if (kstate === 'ok') kstate = 'missing'; fail('keys', id, `signature ${i}: ${kf} is not in the bundle`); return; }
      const kj = tryJson(kb);
      if (!isObj(kj) || kj.v !== 2 || kj.k !== s.key.k || kj.p !== s.key.p) { kstate = 'mismatch'; fail('keys', id, `signature ${i}: ${kf} is not the key the record carries`); }
    });
    out.key = keyed ? kstate : 'none';
  }

  // ---- 7. replies ----
  /** @type {Map<string, Set<string>>} */
  const replySlugs = new Map();
  for (const [rel, c] of kinds) {
    if (c.kind !== 'reply') continue;
    const b = bytesOf.get(rel);
    const j = b ? tryJson(b) : null;
    if (!isObj(j) || j.kind !== 'reply-text' || j.v !== 2) { fail('replies', null, `${rel}: is not a version 2 reply-text record`); continue; }
    if (j.record_id !== c.id) { fail('replies', null, `${rel}: record_id is not the id in its file name`); continue; }
    if (!bundleOk || !entries.has(c.id)) { fail('replies', null, `${rel}: belongs to a record that is not in the bundle`); continue; }
    replyData.set(rel, { id: c.id, slug: c.slug, json: j });
    const set = replySlugs.get(c.id) ?? new Set();
    set.add(c.slug);
    replySlugs.set(c.id, set);
  }
  for (const { id, entry } of order) {
    const wantSlugs = [...new Set(/** @type {string[]} */ (entry.replies ?? []))].sort();
    const have = [...(replySlugs.get(id) ?? [])].sort();
    if (wantSlugs.join('\n') !== have.join('\n')) fail('replies', id, `the entry lists replies [${wantSlugs.join(', ').slice(0, 80)}], the bundle holds [${have.join(', ').slice(0, 80)}]`);
  }

  // ---- 8. chain (parse, runs, links) ----
  /** @type {Map<number, { sha256: string, m: import('./seal-core.js').Manifest | null, ots: boolean }>} */
  const manifests = new Map();
  /** @type {Set<number>} */
  const proofSeqs = new Set();
  for (const [rel, c] of kinds) {
    if (c.kind !== 'manifest') continue;
    if (c.ots) { proofSeqs.add(c.seq); continue; }
    const b = bytesOf.get(rel);
    if (!b) continue;
    const p = parseManifest(b, c.seq);
    if (!p.ok) { result.chain.problems.push({ seq: c.seq, why: p.why }); fail('chain', null, `manifest ${c.seq}: ${p.why}`); }
    manifests.set(c.seq, { sha256: sha256Hex(b), m: p.ok ? p.manifest : null, ots: false });
  }
  for (const s of proofSeqs) {
    const m = manifests.get(s);
    if (m) m.ots = true;
    else { result.chain.problems.push({ seq: s, why: 'a proof with no manifest' }); fail('chain', null, `manifest ${s}: a proof with no manifest`); }
  }
  const seqs = [...manifests.keys()].sort((a, b) => a - b);
  for (let i = 0; i < seqs.length;) {
    let j = i;
    while (j + 1 < seqs.length && seqs[j + 1] === seqs[j] + 1) j++;
    result.chain.runs.push({ from: seqs[i], to: seqs[j] });
    for (let k = i; k <= j; k++) {
      const cur = manifests.get(seqs[k]);
      const m = cur?.m;
      if (!m) continue;
      if (m.seq !== 1 && m.previous_sha256 === null) { result.chain.problems.push({ seq: m.seq, why: 'only manifest 1 has no previous_sha256' }); fail('chain', null, `manifest ${m.seq}: only manifest 1 has no previous_sha256`); }
      if (m.seq === 1 && m.previous_sha256 !== null) { result.chain.problems.push({ seq: 1, why: 'the first manifest names a previous one' }); fail('chain', null, 'manifest 1: names a previous manifest'); }
      if (k > i) {
        const prev = manifests.get(seqs[k - 1]);
        if (prev && m.previous_sha256 !== prev.sha256) { result.chain.problems.push({ seq: m.seq, why: 'previous_sha256 is not the hash of the manifest before it' }); fail('chain', null, `manifest ${m.seq}: previous_sha256 is not the hash of the manifest before it`); }
      }
    }
    i = j + 1;
  }

  // ---- 9. seals: the shared decision over the bundle's manifests, then `ots info` of each distinct proof ----
  /** @type {WeakMap<object, Map<string, string>>} */
  const cache = new WeakMap();
  const parsedSeqs = seqs.filter((s) => manifests.get(s)?.m);
  /** @param {number} seq */
  const load = (seq) => { const x = manifests.get(seq); return x && x.m ? { m: x.m, sha256: x.sha256, ots: x.ots } : null; };
  /** @type {Set<number>} */
  const used = new Set();
  /** @type {Map<string, { rel: string, stampedSha: string | null, state: BundleSeal | null }>} */
  const proofs = new Map();
  /**
   * @param {string} id
   * @param {string | null} slug
   * @param {string} rel  The bundled file's path.
   * @param {boolean} own
   * @returns {Promise<{ seal: BundleSeal, proof: string | null }>}  `proof`: the proof path to inspect, if any.
   */
  async function sealFor(id, slug, rel, own) {
    const hash = hashes.get(rel);
    if (!hash) return { seal: sealOf('unsealed'), proof: null };
    const key = slug === null ? id : `${id}.${slug}`;
    if (own) {
      const p = recordOtsPath(id);
      if (!proofs.has(p)) proofs.set(p, { rel: p, stampedSha: hash, state: null });
      return { seal: sealOf('unchecked', { via: 'record' }), proof: p };
    }
    const d = await decideSeal({ order: parsedSeqs, load, lists: (m) => entriesOf(m, cache).get(key) === hash });
    if (!d || d.via !== 'manifest') {
      const other = parsedSeqs.find((s) => { const h = entriesOf(/** @type {import('./seal-core.js').Manifest} */ (manifests.get(s)?.m), cache).get(key); return h !== undefined && h !== hash; });
      return { seal: other === undefined ? sealOf('unsealed') : sealOf('bad', { via: 'manifest', listed_in: other, why: `manifest ${other} lists this file with a different hash: it is not the file that was sealed` }), proof: null };
    }
    const to = d.stamp ? d.stamp.seq : d.seq;
    for (let s = d.seq; s <= to; s++) used.add(s);
    if (!d.stamp) {
      const later = [...proofSeqs].some((s) => s > d.seq);
      return { seal: later ? sealOf('bad', { via: 'manifest', listed_in: d.seq, why: `no chain of manifests from ${d.seq} to a stamp is in the bundle` }) : sealOf('unstamped', { via: 'manifest', listed_in: d.seq }), proof: null };
    }
    const p = manifestOtsPath(d.stamp.seq);
    const stamped = manifests.get(d.stamp.seq);
    if (!proofs.has(p) && stamped) proofs.set(p, { rel: p, stampedSha: stamped.sha256, state: null });
    return { seal: sealOf('unchecked', { via: 'manifest', listed_in: d.seq, stamped_by: d.stamp.seq, sealed_at: stamped?.m?.created ?? null }), proof: p };
  }
  /** @type {Array<{ target: BundleSeal, proof: string | null, id: string | null }>} */
  const pending = [];
  for (const out of result.records) {
    const own = kinds.has(recordOtsPath(out.id));
    const rel = recordPath(out.id);
    if (!hashes.has(rel)) continue;
    const r = await sealFor(out.id, null, rel, own);
    out.seal = r.seal;
    pending.push({ target: out.seal, proof: r.proof, id: out.id });
    for (const slug of [...(replySlugs.get(out.id) ?? [])].sort()) {
      const rr = await sealFor(out.id, slug, replyPath(out.id, slug), false);
      out.replies.push({ slug, seal: rr.seal });
      pending.push({ target: rr.seal, proof: rr.proof, id: out.id });
    }
  }
  for (const [rel, c] of kinds) {
    if (c.kind === 'record' && c.ots && !(bundleOk && entries.has(c.id) && kinds.has(recordPath(c.id)))) fail('seals', null, `${rel}: a proof for a record that is not in the bundle`);
  }
  // an unreferenced manifest only adds disclosure (chain check)
  for (const s of seqs) if (bundleOk && !used.has(s)) { result.chain.problems.push({ seq: s, why: 'no record or reply of the bundle uses this manifest' }); fail('chain', null, `manifest ${s}: no record or reply of the bundle uses it`); }

  // `ots info` of each distinct proof, with a per-call and a total time limit; never `upgrade`, never `verify`
  const bin = opts.ots === undefined ? 'ots' : opts.ots;
  const started = Date.now();
  let absent = false;
  let outOfTime = false;
  for (const pr of proofs.values()) {
    /** @type {BundleSeal} */
    let s;
    const abs = path.join(root, pr.rel);
    if (bin === null) s = sealOf('unchecked', { why: 'ots is off' });
    else if (absent) s = sealOf('unchecked', { why: 'ots is not installed' });
    else if (Date.now() - started >= L.BUNDLE_OTS_MAX_MS) { outOfTime = true; s = sealOf('unchecked', { why: 'out of time' }); }
    else {
      const r = await infoProof(bin, abs, { timeoutMs: L.BUNDLE_OTS_TIMEOUT_MS, maxBytes: L.BUNDLE_OTS_OUTPUT_BYTES });
      if ('error' in r) {
        if (r.error === 'ots not found') { absent = true; s = sealOf('unchecked', { why: 'ots is not installed' }); }
        else s = sealOf('unchecked', { why: r.error });
      } else if (!r.info) s = sealOf('bad', { why: 'the proof does not parse or has no attestation' });
      else if (r.info.digest !== pr.stampedSha) s = sealOf('bad', { why: 'the proof commits to other bytes than the file it stamps' });
      else if (r.info.block !== null) s = sealOf('anchored', { block: r.info.block, ...(r.info.merkleRoot ? { merkle_root: r.info.merkleRoot } : {}) });
      else s = sealOf('pending');
    }
    pr.state = s;
  }
  result.ots = bin === null ? 'off' : absent ? 'absent' : outOfTime ? 'out of time' : 'used';
  for (const x of pending) {
    if (!x.proof || x.target.state !== 'unchecked') continue;
    const ps = proofs.get(x.proof)?.state;
    if (!ps) continue;
    x.target.state = ps.state;
    if (ps.block !== undefined) x.target.block = ps.block;
    if (ps.merkle_root !== undefined) x.target.merkle_root = ps.merkle_root;
    if (ps.why !== undefined) x.target.why = ps.why;
  }
  for (const x of pending) if (x.target.state === 'bad') fail('seals', x.id, x.target.why ?? 'bad seal');

  // ---- 10. summary and verdict ----
  const c = result.counts;
  c.records = result.records.length;
  for (const r of result.records) {
    if (r.trust === 'verified') c.verified++; else c.unverified++;
    c[r.seal.state]++;
  }
  if (opts.strict === true) {
    if (result.records.some((r) => r.trust !== 'verified')) fail('strict:verified', null, 'a record is not verified');
    const states = result.records.flatMap((r) => [r.seal.state, ...r.replies.map((y) => y.seal.state)]);
    if (states.some((x) => x !== 'anchored')) fail('strict:anchored', null, 'a seal is not anchored');
  }
  return finish();
}

/** @param {Buffer} b @returns {unknown} */
function tryJson(b) {
  try { return JSON.parse(b.toString('utf8')); } catch { return null; }
}

export { verifyBundle };
