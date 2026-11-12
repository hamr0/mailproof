// `Mailproof#export` (SPEC B13.2): a pair bundle, a plain directory of byte-identical copies of committed trail blobs (records, reply-text
// records, the archived keys they name, the manifests and proofs their seals need), an index (`bundle.json`) and a README, about the
// emails that name any of the given addresses. The recipient checks it with `verifyBundle` (bundle-verify.js) and nothing of ours.
//
// Read-only on the trail: it pins a commit (`git rev-parse HEAD` after the index catch-up) and reads everything at that commit through
// one `git cat-file --batch`, so it holds no lock (a commit's objects are immutable) and never delays capture. The index only PROPOSES
// candidate ids; each record is read from the commit and re-tested with `participantsOf`, so a damaged index cannot add a foreign
// record. Before delivery the bundle is verified by the very code the recipient runs; one that does not verify is never delivered.

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { catFile } from './prune-stream.js';
import { gitLines } from './git.js';
import { headOf, isAncestor, RECORD_ID_RE } from './trail.js';
import { recordPath, recordOtsPath, manifestPath, manifestOtsPath, parseReplyPath, parseKeyPath, assertTrailLayout, BUNDLE_README, BUNDLE_JSON } from './layout.js';
import { readChain } from './seal.js';
import { decideSeal, sha256Hex, chainError } from './seal-core.js';
import { readAnchored } from './ots-upgrade.js';
import { storedStatus, toMs } from './content.js';
import { participantsOf } from './participants.js';
import { factsOf, emailBlock, readmeText } from './bundle-readme.js';
import { verifyBundle } from './bundle-verify.js';
import * as LIM from './limits.js';

const run = promisify(execFile);
const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;
const VERSION = /** @type {string} */ (JSON.parse(fsSync.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
const COMPLETENESS = 'none: the owner chose the selection; nothing here shows that no other email exists';

/**
 * @typedef {Object} ExportResult
 * @property {string} out  The directory (or the `.tar` file when `tar: true`).
 * @property {number} bytes  Of the bundle's files (the tar's size when `tar: true`).
 * @property {number} files
 * @property {string} head  The trail commit the bundle is a snapshot of.
 * @property {string} bundle_sha256  sha256 of `bundle.json`: the bundle's name; tell it to the recipient by another channel.
 * @property {number} records
 * @property {number} replies
 * @property {number} keys
 * @property {number} manifests
 * @property {{ anchored: number, pending: number, unstamped: number, unsealed: number }} seals  Records, as the trail shows them at export.
 * @property {{ stored: number, absent: number }} content  Records whose raw email the content store still holds / does not.
 * @property {true} [dryRun]  Present only for a dry run: the bundle was built and verified in a private temp directory, which is removed; `out` is where it would be written and nothing is there.
 * @property {Array<{ id: string, captured: string, direction: string, from: string | null, subject: string | null }>} [selection]  A dry run only: the records the bundle would hold, oldest first (`from` and `subject` are the signed header values the record carries; untrusted text).
 */

/**
 * @typedef {Object} ExportCtx
 * @property {string} root
 * @property {string} trail
 * @property {string} contentDir
 * @property {number} lockTimeoutMs
 * @property {() => Date} now
 * @property {import('./index-db.js').IndexCfg} indexCfg
 * @property {{ afterSnapshot?: () => Promise<void> | void, beforeMove?: () => Promise<void> | void }} [hooks]  Test seams.
 * @property {{ EXPORT_MAX_RECORDS?: number, BUNDLE_MAX_BYTES?: number, BUNDLE_MAX_FILES?: number }} [limits]  Test seam: lowered bounds.
 */

/** @param {string} code @param {string} msg @returns {Error & { code: string }} */
const err = (code, msg) => Object.assign(new Error(msg), { code });
const rewritten = () => err('ERR_EXPORT_REWRITTEN', 'the trail was rewritten while the export was reading it (a prune, or a restore): nothing was written; run it again');

/** The one name rule for a tar bundle (SPEC B13.2.3): the file ends in `.tar`; a given `out` without it gets it, never doubled. @param {string} out @returns {string} */
const tarName = (out) => (out.endsWith('.tar') ? out : `${out}.tar`);

/**
 * @param {unknown} opts
 * @param {number} maxAddresses
 * @returns {{ with: string[], after: Date | null, before: Date | null, out: string, tar: boolean, dryRun: boolean }}
 */
function parseOptions(opts, maxAddresses) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new TypeError('export: options must be an object');
  const o = /** @type {Record<string, unknown>} */ (opts);
  if (!Array.isArray(o.with) || o.with.length === 0) throw new TypeError('export: with must be a non-empty array of email addresses');
  if (o.with.length > maxAddresses) throw new TypeError(`export: with takes at most ${maxAddresses} addresses`);
  const addrs = [...new Set(o.with.map((a) => {
    if (typeof a !== 'string' || !ADDRESS_RE.test(a.trim())) throw new TypeError('export: every with entry must be one exact email address (a string like bob@example.org)');
    return a.trim().toLowerCase();
  }))].sort();
  const after = o.after === undefined ? null : new Date(toMs(o.after, 'after', 'export'));
  const before = o.before === undefined ? null : new Date(toMs(o.before, 'before', 'export'));
  if (after && before && after.getTime() >= before.getTime()) throw new TypeError('export: after must be earlier than before');
  if (typeof o.out !== 'string' || !o.out) throw new TypeError('export: out must be a path');
  if (o.tar !== undefined && typeof o.tar !== 'boolean') throw new TypeError('export: tar must be a boolean');
  if (o.dryRun !== undefined && typeof o.dryRun !== 'boolean') throw new TypeError('export: dryRun must be a boolean');
  const tar = o.tar === true;
  return { with: addrs, after, before, out: tar ? tarName(o.out) : o.out, tar, dryRun: o.dryRun === true };
}

/** @param {string} p @returns {Promise<string>} The real path of an existing path, else the path itself. */
const real = (p) => fs.realpath(p).catch(() => path.resolve(p));

/** @param {string} child @param {string} parent @returns {boolean} Is `child` the same as, or inside, `parent`? */
function inside(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/**
 * Check `out` (SPEC B13.2.7): must not exist, or be an empty directory you own (never with `tar`, where it is a file); not a symlink; its parent
 * must exist; not inside the trail, the content store or an existing bundle.
 * @param {ExportCtx} ctx
 * @param {string} out
 * @param {boolean} tar
 * @returns {Promise<{ parent: string, target: string }>}
 */
async function checkOut(ctx, out, tar) {
  const abs = path.resolve(out);
  const parentStat = await fs.stat(path.dirname(abs)).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) throw new TypeError(`export: the directory ${path.dirname(abs)} does not exist`);
  const parent = await fs.realpath(path.dirname(abs));
  const target = path.join(parent, path.basename(abs));
  const st = await fs.lstat(target).catch(() => null);
  if (st) {
    if (tar) throw err('ERR_EXPORT_EXISTS', `${target} already exists; an export never overwrites`);
    if (st.isSymbolicLink() || !st.isDirectory()) throw err('ERR_EXPORT_EXISTS', `${target} already exists and is not an empty directory; an export never overwrites`);
    if ((await fs.readdir(target)).length) throw err('ERR_EXPORT_EXISTS', `${target} is not empty; an export never overwrites`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw err('ERR_EXPORT_EXISTS', `${target} is not owned by you`);
  }
  for (const [what, dir] of /** @type {Array<[string, string]>} */ ([['the trail', ctx.root], ['the content store', ctx.contentDir]])) {
    if (inside(target, await real(dir))) throw err('ERR_EXPORT_EXISTS', `out is inside ${what} (${dir}): a bundle never lands in the repo or the store`);
  }
  // not inside an existing bundle: no ancestor directory holds a bundle.json that says so
  for (let d = parent; ; d = path.dirname(d)) {
    const head = await fs.readFile(path.join(d, BUNDLE_JSON)).then((b) => b.subarray(0, 4096).toString('utf8'), () => '');
    if (head.includes('"mailproof-pair-bundle"')) throw err('ERR_EXPORT_EXISTS', `out is inside an existing bundle (${d})`);
    if (path.dirname(d) === d) break;
  }
  return { parent, target };
}

/**
 * Run the export.
 * @param {ExportCtx} ctx
 * @param {unknown} rawOpts
 * @returns {Promise<ExportResult>}
 */
async function runExport(ctx, rawOpts) {
  const maxRecords = ctx.limits?.EXPORT_MAX_RECORDS ?? LIM.EXPORT_MAX_RECORDS;
  const maxBytes = ctx.limits?.BUNDLE_MAX_BYTES ?? LIM.BUNDLE_MAX_BYTES;
  const maxFiles = ctx.limits?.BUNDLE_MAX_FILES ?? LIM.BUNDLE_MAX_FILES;
  const o = parseOptions(rawOpts, LIM.EXPORT_MAX_ADDRESSES);
  const { parent, target } = await checkOut(ctx, o.out, o.tar);
  if (o.tar) {
    try { await run('tar', ['--version']); } catch { throw err('ERR_EXPORT_TAR', 'tar not found: install tar or export without --tar'); }
  }
  const name = o.tar ? path.basename(target).replace(/\.tar$/, '') : path.basename(target);
  if (o.tar && (!name || name.startsWith('-'))) throw new TypeError('export: with tar, the file name must not start with "-"');
  await assertTrailLayout(ctx.root);

  // 2. candidates (the index proposes; ERR_TRAIL_LOCKED and ERR_INDEX_UNAVAILABLE come from here)
  const { listIndex } = await import('./index-db.js');
  /** @type {Set<string>} */
  const candidates = new Set();
  for (const a of o.with) {
    const rows = await listIndex(ctx.indexCfg, { with: a, ...(o.after ? { after: o.after } : {}), ...(o.before ? { before: o.before } : {}) });
    for (const r of rows) candidates.add(r.id);
  }
  if (candidates.size === 0) throw err('ERR_EXPORT_EMPTY', 'no recorded email names those addresses in that range: nothing to export');
  if (candidates.size > maxRecords) throw err('ERR_EXPORT_TOO_BIG', `${candidates.size} emails match; a bundle holds at most ${maxRecords}: narrow it with after/before`);

  // 3. pin the snapshot
  const snapshot = await headOf(ctx.root);
  if (!snapshot) throw rewritten();

  const tmp = await fs.mkdtemp(path.join(parent, '.mailproof-export-'));
  try {
    await fs.chmod(tmp, 0o700);
    const stage = path.join(tmp, name);
    await fs.mkdir(stage, { mode: 0o700 });
    /** @type {Map<string, string>} */
    const written = new Map();   // bundle path -> sha256, in write order
    let totalBytes = 0;
    /** @param {string} rel @param {Buffer | string} bytes */
    const put = async (rel, bytes) => {
      if (written.has(rel)) return;
      totalBytes += Buffer.byteLength(bytes);
      if (written.size + 1 > maxFiles) throw err('ERR_EXPORT_TOO_BIG', `the bundle would hold more than ${maxFiles} files: narrow the selection`);
      if (totalBytes > maxBytes) throw err('ERR_EXPORT_TOO_BIG', `the bundle would pass ${maxBytes} bytes: narrow the selection with after/before`);
      const abs = path.join(stage, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
      await fs.writeFile(abs, bytes, { flag: 'wx', mode: 0o600 });
      written.set(rel, sha256Hex(bytes));
    };

    /** @typedef {{ state: string, via: string | null, listed_in: number | null, stamped_by: number | null }} SealOut */
    /** @type {Array<{ id: string, captured: string, direction: string, portable: unknown, live: unknown, body: string, facts: Record<string, any>, keyFiles: string[], attachments: Array<{ filename: string | null, size: number, sha256: string }>, raw: { sha256: string, size: number }, hash: string, replies: Array<{ slug: string, sha256: string, hash: string, seal: SealOut }>, ots: boolean, seal: SealOut }>} */
    const sel = [];
    /** @type {SealOut} */
    const NOSEAL = { state: 'unsealed', via: null, listed_in: null, stamped_by: null };
    /** @type {Map<number, { sha256: string, previous: string | null, ots: boolean }>} */
    const info = new Map();
    /** @type {Map<string, number>} */
    const listedAt = new Map();
    const keyFiles = new Set();
    /** @type {Awaited<ReturnType<typeof readAnchored>>} */
    let anchored;
    /** @type {Map<string, boolean>} */
    const stored = new Map();
    /** @type {Map<string, boolean[]>} */
    const attStored = new Map();
    /** @type {Map<number, Buffer | null>} */
    const manifestBytes = new Map();

    try {
      // 4. records, re-tested at the snapshot
      const cat = catFile(ctx.root);
      try {
        const withSet = new Set(o.with);
        const lo = o.after ? o.after.getTime() : -Infinity;
        const hi = o.before ? o.before.getTime() : Infinity;
        for (const id of [...candidates].sort()) {
          if (!RECORD_ID_RE.test(id)) continue;
          const bytes = await cat.get(`${snapshot}:${recordPath(id)}`);
          if (!bytes) throw rewritten();
          /** @type {any} */
          let rec = null;
          try { rec = JSON.parse(bytes.toString('utf8')); } catch { rec = null; }
          if (!rec || typeof rec !== 'object' || rec.v !== 2 || rec.id !== id) continue;
          if (!participantsOf(rec).some((p) => withSet.has(p.address))) continue;
          const ms = Date.parse(String(rec.captured));
          if (!Number.isFinite(ms) || ms < lo || ms >= hi) continue;
          await put(recordPath(id), bytes);
          const sigs = Array.isArray(rec.signatures) ? rec.signatures : [];
          const kf = [];
          for (const s of sigs) {
            if (!s || typeof s.key_file !== 'string') continue;
            if (!parseKeyPath(s.key_file)) throw err('ERR_EXPORT_SELF_CHECK', `record ${id.slice(0, 12)} names ${s.key_file.slice(0, 80)}, which is not an archived key path: the trail is damaged`);
            kf.push(s.key_file);
          }
          const atts = (Array.isArray(rec.attachments) ? rec.attachments : []).filter((/** @type {any} */ a) => a && typeof a.sha256 === 'string').map((/** @type {any} */ a) => ({ filename: typeof a.filename === 'string' ? a.filename : null, size: Number(a.size) || 0, sha256: String(a.sha256).replace(/^sha256:/, '') }));
          const raw = typeof rec.message?.raw_sha256 === 'string' ? rec.message.raw_sha256.replace(/^sha256:/, '') : '';
          sel.push({
            id, captured: rec.captured, direction: rec.direction, portable: rec.verdicts?.portable?.trust, live: rec.verdicts?.live?.trust, body: typeof rec.body_status === 'string' ? rec.body_status : 'not-checked',
            facts: factsOf(rec), keyFiles: kf, attachments: atts, raw: { sha256: raw, size: Number(rec.message?.size) || 0 }, hash: sha256Hex(bytes), replies: [], ots: false, seal: NOSEAL,
          });
        }
        if (sel.length === 0) throw err('ERR_EXPORT_EMPTY', 'no recorded email names those addresses in that range: nothing to export');
        sel.sort((a, b) => (a.captured < b.captured ? -1 : a.captured > b.captured ? 1 : a.id < b.id ? -1 : 1));
        const byId = new Map(sel.map((s) => [s.id, s]));

        // legacy per-record proofs, reply-text records, archived keys
        for (const s of sel) {
          const ots = await cat.get(`${snapshot}:${recordOtsPath(s.id)}`);
          if (ots) { await put(recordOtsPath(s.id), ots); s.ots = true; }
          for (const k of s.keyFiles) keyFiles.add(k);
        }
        /** @type {Array<{ id: string, slug: string, path: string }>} */
        const replyPaths = [];
        await gitLines(ctx.root, ['ls-tree', '-r', '--name-only', '-z', snapshot, '--', 'replies'], (p) => {
          const y = parseReplyPath(p);
          if (y && byId.has(y.id)) replyPaths.push({ id: y.id, slug: y.slug, path: p });
        }, { sep: '\0' });
        for (const r of replyPaths.sort((a, b) => (a.path < b.path ? -1 : 1))) {
          const bytes = await cat.get(`${snapshot}:${r.path}`);
          if (!bytes) throw rewritten();
          let textSha = '';
          try { textSha = String(JSON.parse(bytes.toString('utf8')).text_sha256 ?? ''); } catch { /* the README just omits it */ }
          await put(r.path, bytes);
          /** @type {NonNullable<ReturnType<typeof byId.get>>} */ (byId.get(r.id)).replies.push({ slug: r.slug, sha256: textSha, hash: sha256Hex(bytes), seal: NOSEAL });
        }
        for (const k of [...keyFiles].sort()) {
          const bytes = await cat.get(`${snapshot}:${k}`);
          if (!bytes) throw err('ERR_EXPORT_SELF_CHECK', `${k} is named by a record but the trail does not hold it: the trail is damaged`);
          await put(k, bytes);
        }

        // 5. seals: one pass over the manifests (readChain verifies every link; a broken chain is ERR_STAMP_CHAIN)
        /** @type {Map<string, string>} */
        const hashOf = new Map();
        for (const s of sel) { if (!s.ots) hashOf.set(s.id, s.hash); for (const r of s.replies) hashOf.set(`${s.id}.${r.slug}`, r.hash); }
        const chain = await readChain(ctx.root, snapshot, (m, i) => {
          info.set(m.seq, { sha256: i.sha256, previous: m.previous_sha256, ots: i.ots });
          for (const e of m.records) if (hashOf.get(e[0]) === e[1] && !listedAt.has(e[0])) listedAt.set(e[0], m.seq);
          for (const e of m.replies) { const k = `${e[0]}.${e[1]}`; if (hashOf.get(k) === e[2] && !listedAt.has(k)) listedAt.set(k, m.seq); }
        });
        if (chain.broken) throw chainError(chain.broken.seq, chain.broken.why);
        anchored = await readAnchored(ctx.root, ctx.trail);
        /** @param {number} seq */
        const slim = (seq) => { const x = info.get(seq); return x ? { m: { v: /** @type {const} */ (1), seq, previous_sha256: x.previous, created: '', records: [], replies: [] }, sha256: x.sha256, ots: x.ots } : null; };
        /** @param {string} key @param {boolean} own */
        const decide = (key, own) => decideSeal({ own, order: listedAt.has(key) ? [/** @type {number} */ (listedAt.get(key))] : [], load: slim, lists: () => true });
        /** @type {Set<number>} */
        const need = new Set();
        /** @param {Awaited<ReturnType<typeof decide>>} d @param {boolean} anch @returns {{ state: string, via: string | null, listed_in: number | null, stamped_by: number | null }} */
        const stateOf = (d, anch) => {
          if (!d) return { state: 'unsealed', via: null, listed_in: null, stamped_by: null };
          if (d.via === 'record') return { state: anch ? 'anchored' : 'pending', via: 'record', listed_in: null, stamped_by: null };
          if (!d.stamp) return { state: 'unstamped', via: 'manifest', listed_in: d.seq, stamped_by: null };
          for (let q = d.seq; q <= d.stamp.seq; q++) need.add(q);
          return { state: anchored.manifests.has(d.stamp.seq) ? 'anchored' : 'pending', via: 'manifest', listed_in: d.seq, stamped_by: d.stamp.seq };
        };
        for (const s of sel) {
          const d = await decide(s.id, s.ots);
          const st = stateOf(d, s.ots && anchored.records.has(s.id));
          s.seal = st;
          for (const r of s.replies) r.seal = stateOf(await decide(`${s.id}.${r.slug}`, false), false);
        }
        for (const q of [...need].sort((a, b) => a - b)) {
          const mb = await cat.get(`${snapshot}:${manifestPath(q)}`);
          if (!mb) throw rewritten();
          await put(manifestPath(q), mb);
          if (info.get(q)?.ots) {
            const ob = await cat.get(`${snapshot}:${manifestOtsPath(q)}`);
            if (!ob) throw rewritten();
            await put(manifestOtsPath(q), ob);
          }
        }
        for (const s of sel) {
          const attHex = s.attachments.map((a) => a.sha256);
          const st = await storedStatus(ctx.contentDir, s.id, attHex);
          stored.set(s.id, st.raw);
          attStored.set(s.id, st.attachments);
        }
      } finally { cat.close(); }
    } catch (e) {
      // a read that failed because the objects are gone (a prune swap) is a rewrite, not a git error
      const code = /** @type {any} */ (e)?.code;
      if (typeof code === 'string' && code.startsWith('ERR_')) throw e;
      const head = await headOf(ctx.root).catch(() => null);
      if (!head || !(head === snapshot || (await isAncestor(ctx.root, snapshot, head)))) throw rewritten();
      throw e;
    }
    await ctx.hooks?.afterSnapshot?.();

    // 5b. README, then bundle.json (written last, after every other file is hashed)
    const created = ctx.now().toISOString();
    const iso = (/** @type {Date | null} */ d) => (d ? d.toISOString() : null);
    const blocks = sel.map((s, i) => emailBlock(i + 1, s.facts, s.seal, {
      raw: { sha256: s.raw.sha256, stored: stored.get(s.id) === true },
      attachments: s.attachments.map((a, j) => ({ ...a, stored: attStored.get(s.id)?.[j] === true })),
    }, s.replies.map((r) => ({ slug: r.slug, sha256: r.sha256 }))));
    await put(BUNDLE_README, readmeText({ created, version: VERSION, trail: ctx.trail, head: snapshot, with: o.with, after: iso(o.after), before: iso(o.before), records: sel.length, blocks }));
    const entries = sel.map((s) => {
      const seal = s.seal;
      return {
        id: s.id, file: recordPath(s.id), captured: s.captured, direction: s.direction, portable: s.portable, live: s.live, body_status: s.body,
        seal: { state: seal.state, via: seal.via, listed_in: seal.listed_in, stamped_by: seal.stamped_by },
        content: {
          raw: { sha256: s.raw.sha256, size: s.raw.size, stored: stored.get(s.id) === true },
          attachments: s.attachments.map((a, j) => ({ filename: a.filename, size: a.size, sha256: a.sha256, stored: attStored.get(s.id)?.[j] === true })),
        },
        replies: s.replies.map((r) => r.slug).sort(),
      };
    });
    const files = Object.fromEntries([...written.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const bundleJson = `${JSON.stringify({
      v: 1, kind: 'mailproof-pair-bundle', created, mailproof: VERSION, trail: ctx.trail, trail_head: snapshot,
      selection: { with: o.with, after: iso(o.after), before: iso(o.before), records: sel.length },
      completeness: COMPLETENESS, records: entries, files,
    }, null, 2)}\n`;
    await put(BUNDLE_JSON, bundleJson);   // (not part of `files`: it was hashed above before this put)
    const bundleSha = sha256Hex(bundleJson);

    // 6. self-check: the recipient's own code, without ots
    const check = await verifyBundle(stage, { ots: null, _limits: { BUNDLE_MAX_BYTES: maxBytes, BUNDLE_MAX_FILES: maxFiles } });
    if (!check.ok) {
      const first = check.problems[0];
      throw err('ERR_EXPORT_SELF_CHECK', `the bundle did not verify, so it was not delivered: ${check.failed.join(', ')}${first ? ` (${first.why})` : ''}`);
    }

    /** @param {number} outBytes @returns {ExportResult} */
    const summary = (outBytes) => {
      /** @type {ExportResult['seals']} */
      const seals = { anchored: 0, pending: 0, unstamped: 0, unsealed: 0 };
      for (const s of sel) seals[/** @type {keyof typeof seals} */ (s.seal.state)]++;
      let storedN = 0;
      for (const s of sel) if (stored.get(s.id)) storedN++;
      return {
        out: target, bytes: outBytes, files: written.size, head: snapshot, bundle_sha256: bundleSha, records: sel.length,
        replies: sel.reduce((n, s) => n + s.replies.length, 0), keys: keyFiles.size, manifests: [...written.keys()].filter((p) => /^manifests\/\d{8}\.json$/.test(p)).length,
        seals, content: { stored: storedN, absent: sel.length - storedN },
      };
    };
    // a dry run stops here: the bundle was built and verified in the temp directory (removed below), nothing is at `out`
    if (o.dryRun) {
      return {
        ...summary(totalBytes), dryRun: true,
        selection: sel.map((s) => ({ id: s.id, captured: String(s.captured), direction: String(s.direction), from: s.facts.from.length ? s.facts.from.map((/** @type {{ address: string }} */ x) => x.address).join(', ') : null, subject: s.facts.subject ?? null })),
      };
    }

    // 7. still the same history? then move it into place
    await ctx.hooks?.beforeMove?.();
    const head = await headOf(ctx.root);
    if (!head || !(head === snapshot || (await isAncestor(ctx.root, snapshot, head)))) throw rewritten();
    let outBytes = totalBytes;
    if (o.tar) {
      await (await fs.open(target, 'wx', 0o600)).close();
      try {
        await run('tar', ['-C', tmp, '-cf', target, name]);
        outBytes = (await fs.stat(target)).size;
      } catch (e) {
        await fs.rm(target, { force: true }).catch(() => {});
        throw err('ERR_EXPORT_TAR', `tar failed: ${String(/** @type {any} */ (e)?.stderr ?? e).trim().slice(0, 300)}`);
      }
    } else {
      await fs.rename(stage, target);
    }
    return summary(outBytes);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});   // what is left of our own temp directory (empty after the move)
  }
}

export { runExport, parseOptions };
