// Bytes in and bytes out (SPEC B12.6). JSON carries strings, not bytes, and a record id is the sha256 of the exact bytes,
// so a raw email arrives as `base64` or as a `path` the server reads itself. A `path` is read at the model's request, so it
// is bounded: absolute, resolving (symlinks followed) to a regular file inside `mcp.inputDirs`, checked again at open time on
// the descriptor. Bytes out are written only into `mcp.outputDir`, never overwriting.

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { MAX_TOTAL_BYTES } from '../proof/limits.js';
import { ToolError, badArgument } from './errors.js';
import { isTarFile } from '../proof/bundle-tar.js';

/**
 * @typedef {Object} InputOptions
 * @property {string[]} inputDirs
 * @property {() => Promise<void>} [afterPathCheck]  Test seam: runs between the path check and the open.
 */

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * @param {string} s
 * @returns {Buffer}
 */
export function decodeBase64(s) {
  const t = s.replace(/[\r\n]/g, '');
  if (Math.floor((t.length * 3) / 4) > MAX_TOTAL_BYTES) throw new ToolError('ERR_TOO_LARGE', `the content is over the ${MAX_TOTAL_BYTES} byte limit`);
  if (!BASE64_RE.test(t)) throw badArgument('base64 is not valid base64');
  return Buffer.from(t, 'base64');
}

/**
 * The real path of an absolute `path` that lies inside one of the allowed folders (symlinks followed), or a refusal.
 * @param {string} p
 * @param {InputOptions} o
 * @param {string} what  For the refusal: "a readable regular file" or "a folder".
 * @returns {Promise<string>}
 */
async function resolveAllowed(p, o, what) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) throw badArgument('path must be an absolute path');
  if (!o.inputDirs.length) throw new ToolError('ERR_PATH_NOT_ALLOWED', 'reading files by path is turned off: the owner lists folders in mcp.inputDirs of the mailproof config; pass the content as base64 instead');
  const refused = () => new ToolError('ERR_PATH_NOT_ALLOWED', `the path is not ${what} inside the folders listed in mcp.inputDirs`);
  /** @type {string} */
  let real;
  try { real = await fs.realpath(p); } catch { throw refused(); }
  /** @type {string[]} */
  const dirs = [];
  for (const d of o.inputDirs) { try { dirs.push(await fs.realpath(d)); } catch { /* a folder that is gone allows nothing */ } }
  if (!dirs.some((d) => real.startsWith(d.endsWith(path.sep) ? d : d + path.sep))) throw refused();
  return real;
}

/**
 * A bundle named by an absolute `path` inside one of the allowed folders: a folder, or the `.tar` file `export` writes (a regular file).
 * @param {string} p
 * @param {InputOptions} o
 * @returns {Promise<string>}  Its real path.
 */
export async function resolveAllowedBundle(p, o) {
  const real = await resolveAllowed(p, o, 'a bundle folder or .tar file');
  const st = await fs.lstat(real).catch(() => null);
  if (!st || !(st.isDirectory() || (st.isFile() && (real.endsWith('.tar') || await isTarFile(real))))) throw new ToolError('ERR_PATH_NOT_ALLOWED', 'the path is not a bundle folder or .tar file inside the folders listed in mcp.inputDirs');
  return real;
}

/**
 * Read a file named by an absolute `path` inside one of the allowed folders.
 * @param {string} p
 * @param {InputOptions} o
 * @returns {Promise<Buffer>}
 */
export async function readAllowedFile(p, o) {
  const real = await resolveAllowed(p, o, 'a readable regular file');
  const refused = () => new ToolError('ERR_PATH_NOT_ALLOWED', 'the path is not a readable regular file inside the folders listed in mcp.inputDirs');
  const before = await fs.lstat(real).catch(() => null);
  if (!before || !before.isFile()) throw refused();
  if (before.size > MAX_TOTAL_BYTES) throw new ToolError('ERR_TOO_LARGE', `the file is ${before.size} bytes; the limit is ${MAX_TOTAL_BYTES}`);
  await o.afterPathCheck?.();
  /** @type {import('node:fs/promises').FileHandle} */
  let fh;
  try { fh = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw refused(); }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) throw refused();   // swapped between the check and the open
    if (st.size > MAX_TOTAL_BYTES) throw new ToolError('ERR_TOO_LARGE', `the file is ${st.size} bytes; the limit is ${MAX_TOTAL_BYTES}`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally { await fh.close(); }
}

/**
 * The bytes of a tool argument pair: exactly one of `path` and `base64`.
 * @param {{ path?: string, base64?: string }} args
 * @param {InputOptions} o
 * @param {boolean} [optional]  When neither is given: return null instead of an error.
 * @returns {Promise<Buffer | null>}
 */
export async function readBytes(args, o, optional = false) {
  const hasPath = args.path !== undefined;
  const hasB64 = args.base64 !== undefined;
  if (hasPath && hasB64) throw badArgument('give path or base64, not both');
  if (!hasPath && !hasB64) { if (optional) return null; throw badArgument('give path or base64'); }
  return hasB64 ? decodeBase64(/** @type {string} */ (args.base64)) : readAllowedFile(/** @type {string} */ (args.path), o);
}

/**
 * The path of a plain name inside the output folder (nothing is created): the one rule for every MCP output, a file or a folder.
 * @param {string} name
 * @param {string | null} outputDir
 * @param {string} [arg]  The argument's name, for the refusal.
 * @returns {Promise<string>}  The absolute path (the folder's real path joined with the name).
 */
export async function outputPath(name, outputDir, arg = 'saveTo') {
  if (!outputDir) throw new ToolError('ERR_PATH_NOT_ALLOWED', 'saving files is turned off: the owner sets mcp.outputDir in the mailproof config');
  if (typeof name !== 'string' || !name || name.length > 255 || /[\\/\0]/.test(name) || name === '.' || name === '..') throw badArgument(`${arg} must be a plain file name, not a path`);
  const dir = await fs.realpath(outputDir).catch(() => null);
  if (!dir || !(await fs.stat(dir)).isDirectory()) throw new ToolError('ERR_PATH_NOT_ALLOWED', 'mcp.outputDir is not a folder that exists');
  return path.join(dir, name);
}

/**
 * Write bytes into the output folder under a plain file name: never overwrite, mode 0600.
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {string | null} outputDir
 * @returns {Promise<string>}  The path written.
 */
export async function saveBytes(name, bytes, outputDir) {
  const file = await outputPath(name, outputDir);
  /** @type {import('node:fs/promises').FileHandle} */
  let fh;
  try { fh = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) {
    if (/** @type {{ code?: string }} */ (e)?.code === 'EEXIST') throw new ToolError('ERR_PATH_NOT_ALLOWED', `${name} already exists in the output folder; pick another name`);
    throw new ToolError('ERR_PATH_NOT_ALLOWED', 'the output file could not be created');
  }
  try { await fh.writeFile(bytes); await fh.close(); }
  catch (e) { await fh.close().catch(() => {}); await fs.rm(file, { force: true }); throw e; }
  return file;
}
