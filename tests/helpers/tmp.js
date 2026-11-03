// TEST-ONLY. The one place tests make scratch directories. Every dir is removed again when the test file's
// process exits. A test file runs in its own process under `node --test`, so this list is per file.
// NEVER imported from src/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {Set<string>} */
const live = new Set();
const rm = (/** @type {string} */ dir) => { live.delete(dir); fs.rmSync(dir, { recursive: true, force: true }); };
const sweep = () => { for (const d of [...live]) rm(d); };
process.on('exit', sweep);
// 'exit' does not run when the process dies of a signal (a runner or tool timeout sends SIGTERM, Ctrl-C sends SIGINT),
// which left every dir of a killed run behind. Sweep, then exit the way the signal would have ended us.
for (const [sig, num] of /** @type {const} */ ([['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]])) {
  process.on(sig, () => { sweep(); process.exit(128 + num); });
}

/**
 * @param {string} prefix
 * @returns {string}
 */
export function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  live.add(dir);
  return dir;
}
