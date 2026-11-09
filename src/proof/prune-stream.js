// The git plumbing of prune (SPEC B9): a stream parser for `git fast-export`, a writer for `git fast-import`, a
// persistent `git cat-file --batch`, and tree listings. Stdlib only, git through the `git` binary. Nothing here knows
// what a record is; prune.js decides what to keep.

import { spawn } from 'node:child_process';
import { git } from './git.js';
import { GIT_LISTING_MAX_BYTES } from './limits.js';

/**
 * One commit of a fast-export stream. Header lines are kept as the raw bytes git wrote (decoded as latin1 so they go
 * back byte for byte); `msg` is the message bytes.
 * @typedef {Object} ExportCommit
 * @property {'commit'} type
 * @property {string} oid  The original commit id (needs `--show-original-ids`), else ''.
 * @property {string} author  The whole `author ...` line.
 * @property {string} committer  The whole `committer ...` line.
 * @property {string[]} extra  Other header lines to keep (`encoding ...`).
 * @property {Buffer} msg
 * @property {Array<{ st: 'M' | 'D', mode: string, ref: string, path: string }>} ops  `ref` is a sha (`--no-data`) or a `:mark` (with data).
 */
/** @typedef {{ type: 'blob', mark: string, data: Buffer }} ExportBlob */

/**
 * Run a git command whose stdout is consumed as a stream.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ stdout: import('node:stream').Readable, done: Promise<void>, kill: () => void }}
 *   `done` rejects when git exits non-zero (with its stderr) or cannot start; await it after reading the stream.
 */
function streamGit(cwd, args) {
  const p = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
  const done = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`git ${args[0]} failed (${code}): ${err.trim()}`))));
  }));
  done.catch(() => {});   // the caller awaits it; a failure while nobody waits must not be an unhandled rejection
  return { stdout: p.stdout, done, kill: () => { p.kill('SIGKILL'); } };
}

/**
 * Parse a `git fast-export` stream into commits (and, with data, the blobs before them). Linear history only: a merge,
 * `deleteall` or a line it does not know is an error (nothing is guessed).
 * @param {import('node:stream').Readable} stream
 * @returns {AsyncGenerator<ExportCommit | ExportBlob>}
 */
async function* parseFastExport(stream) {
  let buf = Buffer.alloc(0);
  const it = stream[Symbol.asyncIterator]();
  let eof = false;
  const fill = async () => { const r = await it.next(); if (r.done) eof = true; else buf = buf.length ? Buffer.concat([buf, r.value]) : r.value; };
  /** @returns {Promise<string | null>} */
  const line = async () => {
    for (;;) {
      const i = buf.indexOf(10);
      if (i >= 0) { const s = buf.subarray(0, i).toString('latin1'); buf = buf.subarray(i + 1); return s; }
      if (eof) { if (buf.length === 0) return null; const s = buf.toString('latin1'); buf = Buffer.alloc(0); return s; }
      await fill();
    }
  };
  /** @param {number} n @returns {Promise<Buffer>} */
  const bytes = async (n) => {
    while (buf.length < n + 1 && !eof) await fill();
    const b = Buffer.from(buf.subarray(0, n));
    buf = buf.subarray(n);
    if (buf[0] === 10) buf = buf.subarray(1);   // the LF after a data block
    return b;
  };
  for (let l = await line(); l !== null; l = await line()) {
    if (l === '' || l.startsWith('reset ') || l.startsWith('progress ')) continue;
    if (l === 'blob') {
      let mark = '';
      /** @type {Buffer | null} */
      let data = null;
      while (data === null) {
        const x = await line();
        if (x === null) throw new Error('prune: fast-export stream ended inside a blob');
        if (x.startsWith('mark ')) mark = x.slice(5);
        else if (x.startsWith('data ')) data = await bytes(Number(x.slice(5)));
      }
      yield { type: 'blob', mark, data };
    } else if (l.startsWith('commit ')) {
      /** @type {ExportCommit} */
      const c = { type: 'commit', oid: '', author: '', committer: '', extra: [], msg: Buffer.alloc(0), ops: [] };
      for (let x = await line(); x !== null && x !== ''; x = await line()) {
        if (x.startsWith('mark ') || x.startsWith('from ')) continue;
        if (x.startsWith('original-oid ')) c.oid = x.slice(13);
        else if (x.startsWith('merge ')) throw new Error('prune: the trail has a merge commit; history is not linear');
        else if (x.startsWith('author ')) c.author = x;
        else if (x.startsWith('committer ')) c.committer = x;
        else if (x.startsWith('encoding ')) c.extra.push(x);
        else if (x.startsWith('data ')) c.msg = await bytes(Number(x.slice(5)));
        else if (x === 'deleteall') throw new Error('prune: deleteall in the trail history');
        else if (x.startsWith('M ')) {
          const m = /^M (\d+) (\S+) (.+)$/.exec(x);
          if (!m) throw new Error(`prune: unreadable fast-export line: ${x}`);
          c.ops.push({ st: 'M', mode: m[1], ref: m[2], path: m[3] });
        } else if (x.startsWith('D ')) c.ops.push({ st: 'D', mode: '', ref: '', path: x.slice(2) });
        else throw new Error(`prune: unhandled fast-export line: ${x}`);
      }
      yield c;
    } else throw new Error(`prune: unhandled fast-export line: ${l}`);
  }
}

/**
 * Start `git fast-export` over a revision range and yield its commits (and blobs, with `data`).
 * @param {string} cwd
 * @param {string} range  A commit id, or `<a>..<b>` (then the excluded parent is referenced by id).
 * @param {{ data: boolean }} opts  `data`: stream the blob bytes (small ranges); else blobs are named by sha.
 * @returns {{ items: AsyncGenerator<ExportCommit | ExportBlob>, done: Promise<void>, kill: () => void }}
 */
function exportRange(cwd, range, { data }) {
  const args = ['fast-export', '--reencode=no', '--show-original-ids', '--reference-excluded-parents', ...(data ? [] : ['--no-data']), range];
  const g = streamGit(cwd, args);
  return { items: parseFastExport(g.stdout), done: g.done, kill: g.kill };
}

/**
 * A running `git fast-import` and a writer with back-pressure.
 * @param {string} cwd
 * @returns {{ write: (b: Buffer | string) => Promise<void>, end: () => Promise<void>, kill: () => void }}
 */
function startImport(cwd) {
  const p = spawn('git', ['fast-import', '--quiet', '--depth=50'], { cwd, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
  const done = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`git fast-import failed (${code}): ${err.trim()}`))));
  }));
  done.catch(() => {});
  p.stdin.on('error', () => {});   // a dead child surfaces through `done`
  return {
    /** @param {Buffer | string} b */
    async write(b) {
      if (p.stdin.write(typeof b === 'string' ? Buffer.from(b, 'latin1') : b)) return;
      await Promise.race([new Promise((r) => p.stdin.once('drain', r)), done]);
    },
    async end() { p.stdin.end(); await done; },
    kill() { p.kill('SIGKILL'); },
  };
}

/**
 * A long-lived `git cat-file --batch`: `get(spec)` reads one object (`<sha>` or `<rev>:<path>`), null when it does not exist.
 * @param {string} cwd
 * @returns {{ get: (spec: string) => Promise<Buffer | null>, close: () => void }}
 */
function catFile(cwd) {
  const p = spawn('git', ['cat-file', '--batch'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  /** @type {null | ((v?: unknown) => void)} */
  let wake = null;
  let dead = false;
  p.stdout.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; wake?.(); });
  p.on('close', () => { dead = true; wake?.(); });
  p.on('error', () => { dead = true; wake?.(); });
  p.stdin.on('error', () => {});
  const more = () => new Promise((r) => { wake = r; }).then(() => { wake = null; });
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  /** @param {string} spec @returns {Promise<Buffer | null>} */
  const read = async (spec) => {
    p.stdin.write(`${spec}\n`);
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl >= 0) {
        const head = buf.subarray(0, nl).toString('latin1');
        if (head.endsWith(' missing') || head.endsWith(' ambiguous')) { buf = buf.subarray(nl + 1); return null; }
        const size = Number(head.split(' ')[2]);
        if (!Number.isInteger(size)) throw new Error(`prune: unreadable cat-file answer for ${spec}`);
        if (buf.length >= nl + 1 + size + 1) {
          const body = Buffer.from(buf.subarray(nl + 1, nl + 1 + size));
          buf = buf.subarray(nl + 1 + size + 1);
          return body;
        }
      }
      if (dead) throw new Error('prune: git cat-file stopped');
      await more();
    }
  };
  return {
    get: (spec) => { const r = chain.then(() => read(spec)); chain = r.catch(() => {}); return r; },
    close: () => { p.stdin.end(); },
  };
}

/**
 * Every file at `rev` as path -> blob id.
 * @param {string} root
 * @param {string} rev
 * @returns {Promise<Map<string, string>>}
 */
async function lsTree(root, rev) {
  const out = await git(root, ['ls-tree', '-r', '-z', '--full-tree', rev], { maxBuffer: GIT_LISTING_MAX_BYTES });
  /** @type {Map<string, string>} */
  const m = new Map();
  for (const e of out.split('\0')) {
    if (!e) continue;
    const tab = e.indexOf('\t');
    m.set(e.slice(tab + 1), e.slice(0, tab).split(' ')[2]);
  }
  return m;
}

/**
 * The net change between two commits: path -> new blob id, or null for a deletion.
 * @param {string} root
 * @param {string} a
 * @param {string} b
 * @returns {Promise<Map<string, string | null>>}
 */
async function diffTree(root, a, b) {
  const out = await git(root, ['diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', a, b], { maxBuffer: GIT_LISTING_MAX_BYTES });
  const parts = out.split('\0');
  /** @type {Map<string, string | null>} */
  const m = new Map();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (!parts[i]) continue;
    const f = parts[i].slice(1).split(' ');   // oldmode newmode oldsha newsha status
    m.set(parts[i + 1], f[4].startsWith('D') ? null : f[3]);
  }
  return m;
}

export { exportRange, startImport, catFile, lsTree, diffTree, streamGit, parseFastExport };
