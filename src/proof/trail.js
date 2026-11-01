// The on-disk trail (SPEC Part B3): one git repo per trail, one commit per
// record. Records and archived keys are plain files in the working tree, so a
// `git clone` is the portable proof. Writers are serialised in-process by a
// mutex keyed on the trail path. There is NO cross-process guard: concurrent
// processes writing one trail are unsupported (use a single writer). They can
// fail on git's `index.lock`, and a failed process's rollback below removes
// files it wrote, which can include records another process already
// committed, leaving the working tree dirty.

import fs from 'node:fs/promises';
import path from 'node:path';
import { git, GIT_IDENTITY } from './git.js';
import { withMutex } from './mutex.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */

const TRAIL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RECORD_ID_RE = /^[0-9a-f]{32}$/;

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Stable serialisation: insertion order, 2-space indent, trailing newline.
 * @param {unknown} obj
 * @returns {string}
 */
function serialise(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Create the trail's repo on first use. Idempotent.
 * @param {string} root
 * @param {string} name
 * @param {string} createdIso
 * @returns {Promise<void>}
 */
async function ensureTrail(root, name, createdIso) {
  if (await exists(path.join(root, '.git'))) return;
  await fs.mkdir(path.join(root, 'records'), { recursive: true });
  await fs.writeFile(path.join(root, 'trail.json'), serialise({ v: 2, name, created: createdIso }));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', GIT_IDENTITY.name]);
  await git(root, ['config', 'user.email', GIT_IDENTITY.email]);
  await git(root, ['add', 'trail.json']);
  await git(root, ['commit', '-m', 'trail created']);
}

/**
 * Read a record by id; null when absent, malformed or the id is not 32 hex.
 * @param {string} root
 * @param {string} id
 * @returns {Promise<MpRecord | null>}
 */
async function readRecord(root, id) {
  if (typeof id !== 'string' || !RECORD_ID_RE.test(id)) return null;
  try { return JSON.parse(await fs.readFile(path.join(root, 'records', `${id}.json`), 'utf8')); }
  catch { return null; }
}

/**
 * All record ids in the trail's working tree.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listIds(root) {
  try {
    return (await fs.readdir(path.join(root, 'records')))
      .filter((f) => f.endsWith('.json') && RECORD_ID_RE.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5));
  } catch { return []; }
}

/**
 * Write one record (+ any new key files) and commit them as one commit. A
 * record whose id exists is a no-op (`duplicate`). On any failure the files
 * written by this call are removed so the tree is never left dirty.
 * @param {string} root
 * @param {string} name
 * @param {{ record: MpRecord, keyFiles: Array<{ rel: string, json: unknown }>, message: string, now: () => Date,
 *           afterWrite?: (recordAbs: string) => Promise<string[]> }} job
 *   `afterWrite` may add files next to the record (the OTS proof); it returns their trail-relative paths.
 * @returns {Promise<{ duplicate: boolean, commit: string, extra: string[] }>}
 */
async function commitRecord(root, name, { record, keyFiles, message, now, afterWrite }) {
  return withMutex(root, async () => {
    await ensureTrail(root, name, now().toISOString());
    const rel = `records/${record.id}.json`;
    if (await exists(path.join(root, rel))) {
      return { duplicate: true, commit: await git(root, ['rev-parse', 'HEAD']), extra: [] };
    }
    /** @type {string[]} */
    const written = [];
    try {
      for (const k of keyFiles) {
        const abs = path.join(root, k.rel);
        if (await exists(abs)) continue; // archived once per domain+selector+key, never rewritten
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, serialise(k.json));
        written.push(k.rel);
      }
      await fs.writeFile(path.join(root, rel), serialise(record));
      written.push(rel);
      const extra = afterWrite ? await afterWrite(path.join(root, rel)) : [];
      written.push(...extra);
      await git(root, ['add', '--', ...written]);
      await git(root, ['commit', '-m', message]);
      return { duplicate: false, commit: await git(root, ['rev-parse', 'HEAD']), extra };
    } catch (err) {
      try { await git(root, ['reset', '-q']); } catch { /* nothing staged */ }
      await Promise.all(written.map((r) => fs.rm(path.join(root, r), { force: true })));
      throw err;
    }
  });
}

export { TRAIL_NAME_RE, RECORD_ID_RE, serialise, ensureTrail, readRecord, listIds, commitRecord };
