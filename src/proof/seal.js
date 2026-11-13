// The seal (SPEC B13.1): stamp manifests and their chain. A manifest lists, by sha256, the record and reply-text files added
// since the previous one and names the previous manifest's file hash; one OpenTimestamps proof on the newest manifest then
// bounds the time of everything before it. This module is the pure and read-only half: the manifest bytes (the writer is
// `serialiseManifest`), reading and verifying the chain at a commit, the "unsealed set" (B13.1.4) and `findSeal` (B13.1.10).
// The job that writes and stamps them is stamp.js. Nothing here takes a lock or runs `ots`: every read is of a commit.

import { git, gitLines } from './git.js';
import { catFile } from './prune-stream.js';
import { manifestPath, manifestOtsPath, parseManifestPath, parseRecordPath, parseReplyPath, recordPath, recordOtsPath, replyPath } from './layout.js';
import { parseNotice } from './prune.js';
import { sha256Hex, chainError, serialiseManifest, parseManifest, decideSeal } from './seal-core.js';

/** @typedef {import('./seal-core.js').Manifest} Manifest */
/** @typedef {{ seq: number, blob: string | null, ots: boolean }} ManifestFile */
/** @typedef {{ via: 'record', stamp: string } | { via: 'manifest', seq: number, listed: string, stamp: { seq: number, own: boolean } | null }} Seal */

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
    /** @param {number} seq @returns {Promise<import('./seal-core.js').LoadedManifest | null>} */
    const load = async (seq) => {
      const f = bySeq.get(seq);
      const bytes = f?.blob ? await cat.get(f.blob) : null;
      const p = bytes ? parseManifest(bytes, seq) : null;
      return bytes && p && p.ok ? { m: p.manifest, sha256: sha256Hex(bytes), ots: f?.ots === true } : null;
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
    const d = await decideSeal({ order: [...order, ...rest], load, lists });
    return d && d.via === 'manifest' ? { via: 'manifest', seq: d.seq, listed, stamp: d.stamp } : null;
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
