// Unpack a `.tar` pair bundle (what `export --tar` writes) into a private temp directory so `verifyBundle` can check it (SPEC B13.3.10).
// The tar is hostile input, so this is a small reader of our own and not the system `tar`: every header is validated BEFORE anything
// is written, and only regular files and directories are ever created (never a link, device or FIFO, which GNU and BSD tar differ on),
// by a path we build ourselves from checked components, with `O_EXCL`, so nothing a name says can leave the temp directory.
// Bounded by the same limits as a bundle folder (entry count, total bytes) and by the length of the tar itself. Reads ustar, GNU long
// names (`L`) and pax `path`/`size` records (what a re-packed tar from another tool carries); anything else is refused.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BLOCK = 512;
const MAX_DEPTH = 6;   // top folder + records/<2hex>/<file> and a margin: deeper is not a bundle
const MAX_NAME = 1024;
const MAX_EXT = 64 * 1024;   // a long-name or pax record

/**
 * Is this regular file a tar? By content, not name: the `ustar` magic at offset 257 of the first 512-byte header (GNU and POSIX tars both carry it).
 * @param {string} file @returns {Promise<boolean>}
 */
export async function isTarFile(file) {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return false;
  try {
    const b = Buffer.alloc(BLOCK);
    const { bytesRead } = await fh.read(b, 0, BLOCK, 0);
    return bytesRead === BLOCK && b.toString('latin1', 257, 262) === 'ustar';
  } finally { await fh.close(); }
}

/** @typedef {{ dir: string, cleanup: () => Promise<void> } | { problems: string[], cleanup: () => Promise<void> }} Unpacked */

/** @param {Buffer} b @param {number} off @param {number} len @returns {number | null} */
function octal(b, off, len) {
  if (b[off] & 0x80) return null;   // base-256 sizes: not something mailproof writes
  const s = b.toString('latin1', off, off + len).replace(/\0.*$/, '').trim();
  if (s === '') return 0;
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : null;
}

/** @param {Buffer} b @returns {boolean} */
function checksumOk(b) {
  const want = octal(b, 148, 8);
  if (want === null) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : b[i];
  return sum === want;
}

/** @param {Buffer} b @param {number} off @param {number} len @returns {string} */
const cstr = (b, off, len) => { const e = b.indexOf(0, off); return b.toString('utf8', off, e === -1 || e > off + len ? off + len : e); };

/** @param {string} data @returns {Map<string, string>} */
function paxRecords(data) {
  /** @type {Map<string, string>} */
  const m = new Map();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(' ', i);
    const len = Number(data.slice(i, sp));
    if (sp === -1 || !Number.isInteger(len) || len <= 0 || i + len > data.length) break;
    const rec = data.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) m.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return m;
}

/**
 * The checked components of an entry name, or why it is refused.
 * @param {string} name
 * @returns {string[] | string}
 */
function components(name) {
  if (name.length > MAX_NAME) return 'a name is too long';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(name)) return 'a name has a control character or backslash';
  if (name.startsWith('/')) return 'an absolute path';
  const parts = name.split('/');
  if (parts[0] === '.') parts.shift();
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  if (!parts.length) return 'an empty name';
  if (parts.some((c) => c === '' || c === '.' || c === '..')) return 'a name with ".." or an empty part';
  if (parts.length > MAX_DEPTH) return 'a path nested too deep';
  return parts;
}

/**
 * Unpack a tar into a new 0700 temp directory (the single top-level folder is stripped: the returned `dir` is its contents). It never throws
 * for a bad tar: `problems` says why it was refused, and nothing is left behind. Call `cleanup()` when done.
 * @param {string} file
 * @param {{ maxFiles: number, maxBytes: number }} lim
 * @returns {Promise<Unpacked>}
 */
export async function unpackTar(file, lim) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mailproof-vb-'));
  const root = path.join(tmp, 'bundle');
  await fs.mkdir(root, { mode: 0o700 });
  const cleanup = () => fs.rm(tmp, { recursive: true, force: true });
  /** @type {import('node:fs/promises').FileHandle | null} */
  let h = null;
  /** @param {string} why @returns {Promise<Unpacked>} */
  const refuse = async (why) => { await h?.close().catch(() => {}); h = null; await cleanup(); return { problems: [why], cleanup: async () => {} }; };
  try {
    h = await fs.open(file, 'r');
    const total = (await h.stat()).size;
    const fh = h;
    /** @param {number} off @param {number} len @returns {Promise<Buffer>} */
    const readAt = async (off, len) => {
      const b = Buffer.alloc(len);
      const { bytesRead } = await fh.read(b, 0, len, off);
      return bytesRead === len ? b : b.subarray(0, bytesRead);
    };
    let off = 0;
    let entries = 0;
    let bytes = 0;
    /** @type {string | null} */
    let top = null;
    let longName = /** @type {string | null} */ (null);
    /** @type {Map<string, string>} */
    let pax = new Map();
    let ended = false;
    /** @type {Set<string>} */
    const seen = new Set();
    while (off + BLOCK <= total) {
      const hd = await readAt(off, BLOCK);
      off += BLOCK;
      if (hd.length < BLOCK) return await refuse('the tar is cut short');
      if (hd.every((x) => x === 0)) { ended = true; break; }
      if (!checksumOk(hd)) return await refuse('a tar header is damaged (bad checksum)');
      let size = octal(hd, 124, 12);
      const type = String.fromCharCode(hd[156] || 48);
      if (size === null) return await refuse('a tar entry size is not understood');
      if (type === 'L' || type === 'x' || type === 'g') {
        if (size > MAX_EXT || off + size > total) return await refuse('a tar extension record is too large');
        const data = (await readAt(off, size)).toString('utf8');
        off += Math.ceil(size / BLOCK) * BLOCK;
        if (type === 'L') longName = data.replace(/\0.*$/, '');
        else if (type === 'x') pax = paxRecords(data);
        continue;
      }
      if (type !== '0' && type !== '5') return await refuse(`a tar entry that is not a plain file or folder (type "${type.replace(/[^ -~]/g, '?')}")`);
      const magic = hd.toString('latin1', 257, 263);
      let name = longName ?? pax.get('path') ?? (magic === 'ustar\0' && cstr(hd, 345, 155) ? `${cstr(hd, 345, 155)}/${cstr(hd, 0, 100)}` : cstr(hd, 0, 100));
      const paxSize = pax.get('size');
      if (paxSize !== undefined) { if (!/^\d{1,15}$/.test(paxSize)) return await refuse('a tar entry size is not understood'); size = Number(paxSize); }
      longName = null; pax = new Map();
      const parts = components(name);
      if (typeof parts === 'string') return await refuse(`${parts} in the tar`);
      name = parts.join('/');
      if (++entries > lim.maxFiles) return await refuse(`more than ${lim.maxFiles} entries: the tar is refused unread`);
      if (top === null) top = parts[0];
      else if (parts[0] !== top) return await refuse('the tar must hold one top-level folder');
      if (type === '5') {
        if (size !== 0) return await refuse('a folder entry has data');
        if (parts.length > 1) await fs.mkdir(path.join(root, ...parts.slice(1)), { recursive: true, mode: 0o700 });
        continue;
      }
      if (parts.length < 2) return await refuse('the tar must hold one top-level folder (a file sits at its top)');
      bytes += size;
      if (bytes > lim.maxBytes) return await refuse(`the bundle is over ${lim.maxBytes} bytes: refused unread`);
      if (off + size > total) return await refuse('the tar is cut short');
      if (seen.has(name)) return await refuse('the same name twice in the tar');
      seen.add(name);
      const dest = path.join(root, ...parts.slice(1));
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      const out = await fs.open(dest, 'wx', 0o600);
      try {
        let left = size;
        let at = off;
        while (left > 0) {
          const n = Math.min(left, 1 << 20);
          const chunk = await readAt(at, n);
          if (chunk.length !== n) return await refuse('the tar is cut short');
          await out.write(chunk);
          at += n; left -= n;
        }
      } finally { await out.close(); }
      off += Math.ceil(size / BLOCK) * BLOCK;
    }
    if (!ended && off < total) return await refuse('the tar is cut short');
    if (top === null) return await refuse('the tar is empty');
    await h.close(); h = null;
    return { dir: root, cleanup };
  } catch (e) {
    return await refuse(`the tar cannot be unpacked (${/** @type {any} */ (e)?.code ?? 'error'})`);
  }
}
