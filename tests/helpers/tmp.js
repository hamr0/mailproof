// TEST-ONLY. The one place tests make scratch directories. Every dir is removed again: when the test that asked
// for it ends (pass `t`), and in any case when the test file's process exits (a dir made at file level, or
// outside a test, has no `t`). A test file runs in its own process under `node --test`, so this list is per file.
// NEVER imported from src/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {Set<string>} */
const live = new Set();
const rm = (/** @type {string} */ dir) => { live.delete(dir); fs.rmSync(dir, { recursive: true, force: true }); };
process.on('exit', () => { for (const d of [...live]) rm(d); });

/**
 * @param {string} prefix
 * @param {{ after: (fn: () => void) => void }} [t]  the test context: the dir goes when that test ends
 * @returns {string}
 */
export function makeTmpDir(prefix, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  live.add(dir);
  t?.after(() => rm(dir));
  return dir;
}
