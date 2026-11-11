// The seal (SPEC B13.1): stamp manifests and their chain. A manifest lists, by sha256, the record and reply-text files added
// since the previous one and names the previous manifest's file hash; one OpenTimestamps proof on the newest manifest then
// bounds the time of everything before it. This module is the pure and read-only half: the manifest bytes (the writer is
// `serialiseManifest`), reading and verifying the chain at a commit, the "unsealed set" (B13.1.4) and `findSeal` (B13.1.10).
// The job that writes and stamps them is stamp.js. Nothing here takes a lock or runs `ots`: every read is of a commit.

import crypto from 'node:crypto';
import { git, gitLines } from './git.js';
import { catFile } from './prune-stream.js';
import { manifestPath, manifestOtsPath, parseManifestPath, parseRecordPath, parseReplyPath, recordPath, recordOtsPath, replyPath } from './layout.js';
import { parseNotice } from './prune.js';

/** @typedef {{ v: 1, seq: number, previous_sha256: string | null, created: string, records: Array<[string, string]>, replies: Array<[string, string, string]> }} Manifest */
/** @typedef {{ seq: number, blob: string | null, ots: boolean }} ManifestFile */
/** @typedef {{ via: 'record', stamp: string } | { via: 'manifest', seq: number, listed: string, stamp: { seq: number, own: boolean } | null }} Seal */

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
 * The manifests (and which have a proof) committed at `rev`, oldest first. One streamed `git ls-tree`.
 * @param {string} root
 * @param {string} rev
 * @returns {Promise<ManifestFile[]>}
 */
async function listManifests(root, rev) {
  /** @type {Map<number, ManifestFile>} */
  const by = new Map();
  await gitLines(root, ['ls-tree', '-z', rev, '--', 'manifests/'], (line) => {
    const tab = line.indexOf('\t');
    if (tab < 0) return;
    const m = parseManifestPath(line.slice(tab + 1));
    if (!m) return;
    const e = by.get(m.seq) ?? { seq: m.seq, blob: null, ots: false };
    if (m.ots) e.ots = true; else e.blob = line.slice(0, tab).split(' ')[2] ?? null;
    by.set(m.seq, e);
  }, { sep: '\0' });
  return [...by.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Does the trail's first commit carry a prune notice? (A kept chain may then start above seq 1.)
 * @param {string} root
 * @param {string} rev
 * @returns {Promise<boolean>}
 */
async function prunedAt(root, rev) {
  try { return parseNotice((await git(root, ['log', '--max-parents=0', '--format=%B', rev])).replace(/$/, '\n')).length > 0; } catch { return false; }
}

/**
 * @typedef {Object} ChainInfo
 * @property {ManifestFile[]} files  Every manifest file at `rev`, oldest first.
 * @property {{ seq: number, sha256: string, bytes: Buffer, ots: boolean } | null} latest  The newest manifest (its bytes are kept: the job stamps them).
 * @property {{ seq: number, why: string } | null} broken  The first broken link (the walk stops there); `latest` is then the last good one.
 */

/**
 * Read the manifest chain at `rev` end to end (SPEC B13.1.3): every manifest parses, names its own number, follows the one
 * before by number and by the hash of its bytes. After a prune the first kept manifest may name one that is gone (the notice
 * says so); a gap elsewhere, or a first manifest above 1 in a trail never pruned, is broken. Memory holds one manifest at a time
 * (plus what `onEntry` keeps).
 * @param {string} root
 * @param {string} rev
 * @param {(m: Manifest, info: { sha256: string, ots: boolean }) => void} [onEntry]
 * @returns {Promise<ChainInfo>}
 */
async function readChain(root, rev, onEntry) {
  const files = await listManifests(root, rev);
  /** @type {ChainInfo} */
  const out = { files, latest: null, broken: null };
  if (!files.length) return out;
  const cat = catFile(root);
  try {
    /** @type {{ seq: number, sha256: string } | null} */
    let prev = null;
    for (const f of files) {
      const bytes = f.blob ? await cat.get(f.blob) : null;
      if (!bytes) { out.broken = { seq: f.seq, why: f.blob ? 'cannot be read' : 'its proof has no manifest' }; break; }
      const p = parseManifest(bytes, f.seq);
      if (!p.ok) { out.broken = { seq: f.seq, why: p.why }; break; }
      const m = p.manifest;
      if (prev) {
        if (f.seq !== prev.seq + 1) { out.broken = { seq: f.seq, why: `follows ${prev.seq}: a manifest is missing` }; break; }
        if (m.previous_sha256 !== prev.sha256) { out.broken = { seq: f.seq, why: 'previous_sha256 is not the hash of the manifest before it' }; break; }
      } else if (f.seq === 1) {
        if (m.previous_sha256 !== null) { out.broken = { seq: 1, why: 'the first manifest names a previous one' }; break; }
      } else if (m.previous_sha256 === null || !(await prunedAt(root, rev))) {
        out.broken = { seq: f.seq, why: 'the chain does not start at 1 and the trail was not pruned' }; break;
      }
      const sha = sha256Hex(bytes);
      prev = { seq: f.seq, sha256: sha };
      out.latest = { seq: f.seq, sha256: sha, bytes, ots: f.ots };
      onEntry?.(m, { sha256: sha, ots: f.ots });
    }
  } finally { cat.close(); }
  return out;
}

/**
 * What the trail holds at `rev` that a manifest could list: record files, reply-text files, and the ids that carry their own
 * proof (a 3.3.0 or `record`-mode stamp), from one streamed `git ls-tree`.
 * @param {string} root
 * @param {string} rev
 * @returns {Promise<{ records: string[], replies: Array<{ id: string, slug: string, path: string }>, own: Set<string> }>}  Both lists in ascending path order.
 */
async function scanFiles(root, rev) {
  /** @type {string[]} */
  const records = [];
  /** @type {Array<{ id: string, slug: string, path: string }>} */
  const replies = [];
  /** @type {Set<string>} */
  const own = new Set();
  await gitLines(root, ['ls-tree', '-r', '--name-only', '-z', rev, '--', 'records', 'replies'], (p) => {
    const r = parseRecordPath(p);
    if (r) { if (r.ots) own.add(r.id); else records.push(r.id); return; }
    const y = parseReplyPath(p);
    if (y) replies.push({ id: y.id, slug: y.slug, path: p });
  }, { sep: '\0' });
  return { records, replies, own };
}

/**
 * The unsealed set at `rev` (SPEC B13.1.4): the record and reply-text files not listed by any manifest at `rev` and not
 * carrying their own proof. Defined by content, not commit position. `listed` is filled while the chain is read.
 * @param {{ records: string[], replies: Array<{ id: string, slug: string, path: string }>, own: Set<string> }} scan
 * @param {{ records: Set<string>, replies: Set<string> }} listed  Ids, and `<id>.<slug>`, named by the manifests.
 * @returns {{ records: string[], replies: Array<{ id: string, slug: string, path: string }> }}
 */
function unsealedOf(scan, listed) {
  return {
    records: scan.records.filter((id) => !listed.records.has(id) && !scan.own.has(id)),
    replies: scan.replies.filter((y) => !listed.replies.has(`${y.id}.${y.slug}`)),
  };
}

/**
 * Find the seal of a record or reply-text file (SPEC B13.1.10): its own committed proof, else the manifest that lists the
 * file with its current hash and the stamp that bounds that manifest's time, else null (unsealed). `hint` is the trail index's
 * guess at which manifests list the file: it only says what to read first and never decides; a wrong, missing or failing hint
 * gives the same answer as none (a read of the manifests, newest to oldest).
 * @param {string} root
 * @param {string} id  The record id.
 * @param {{ slug?: string, rev?: string, hint?: (id: string, slug: string | null) => Promise<number[] | null> | number[] | null }} [opts]  `slug`: the reply-text file of that stripper version instead of the record.
 * @returns {Promise<Seal | null>}
 */
async function findSeal(root, id, opts = {}) {
  const rev = opts.rev ?? 'HEAD';
  const slug = opts.slug ?? null;
  const rel = slug === null ? recordPath(id) : replyPath(id, slug);
  if (slug === null) {
    try { await git(root, ['cat-file', '-e', `${rev}:${recordOtsPath(id)}`]); return { via: 'record', stamp: recordOtsPath(id) }; } catch { /* no proof of its own */ }
  }
  /** @type {Buffer | null} */
  let file = null;
  const cat = catFile(root);
  try {
    file = await cat.get(`${rev}:${rel}`);
    if (!file) return null;
    const listed = sha256Hex(file);
    const files = await listManifests(root, rev);
    const bySeq = new Map(files.map((f) => [f.seq, f]));
    /** @param {number} seq @returns {Promise<{ bytes: Buffer, m: Manifest } | null>} */
    const load = async (seq) => {
      const f = bySeq.get(seq);
      const bytes = f?.blob ? await cat.get(f.blob) : null;
      const p = bytes ? parseManifest(bytes, seq) : null;
      return bytes && p && p.ok ? { bytes, m: p.manifest } : null;
    };
    /** @param {Manifest} m */
    const lists = (m) => (slug === null ? m.records.some((e) => e[0] === id && e[1] === listed) : m.replies.some((e) => e[0] === id && e[1] === slug && e[2] === listed));
    /** @type {number[]} */
    let order = [];
    try {
      const h = await opts.hint?.(id, slug);
      if (Array.isArray(h)) order = h.filter((s) => Number.isInteger(s) && bySeq.has(s));
    } catch { /* a failing hint is no hint */ }
    const rest = files.map((f) => f.seq).reverse().filter((s) => !order.includes(s));
    let found = -1;
    for (const seq of [...order, ...rest]) {
      const x = await load(seq);
      if (x && lists(x.m)) { found = seq; break; }
    }
    if (found < 0) return null;
    // the stamp: its own proof, else the nearest later manifest that has one, each link verified
    let at = bySeq.get(found);
    if (at?.ots) return { via: 'manifest', seq: found, listed, stamp: { seq: found, own: true } };
    let prev = await load(found);
    while (prev) {
      const nextSeq = (at?.seq ?? 0) + 1;
      const next = bySeq.get(nextSeq);
      if (!next) break;
      const cur = await load(nextSeq);
      if (!cur || cur.m.previous_sha256 !== sha256Hex(prev.bytes)) break;
      if (next.ots) return { via: 'manifest', seq: found, listed, stamp: { seq: nextSeq, own: false } };
      prev = cur;
      at = next;
    }
    return { via: 'manifest', seq: found, listed, stamp: null };
  } finally { cat.close(); }
}

/**
 * One manifest as committed at `rev`, parsed (null when it is missing or does not parse).
 * @param {string} root
 * @param {string} rev
 * @param {number} seq
 * @returns {Promise<Manifest | null>}
 */
async function readManifestAt(root, rev, seq) {
  const cat = catFile(root);
  try {
    const bytes = await cat.get(`${rev}:${manifestPath(seq)}`);
    const p = bytes ? parseManifest(bytes, seq) : null;
    return p && p.ok ? p.manifest : null;
  } finally { cat.close(); }
}

export { readManifestAt, sha256Hex, chainError, serialiseManifest, parseManifest, listManifests, readChain, scanFiles, unsealedOf, findSeal, manifestPath, manifestOtsPath };
