// The git binary via child_process (no wrapper library): the few plumbing
// calls the ledgers need, one execFile each.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const _execFile = promisify(execFile);

// Git author for ledger commits. Cosmetic: the proof is the commit chain and
// its content, not the author. Neutral + non-routable (RFC 2606 .invalid).
const GIT_IDENTITY = { name: 'mailproof', email: 'noreply@mailproof.invalid' };

/**
 * Run a git subcommand in `cwd`; resolve trimmed stdout, reject with git's stderr.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function git(cwd, args) {
  try {
    const { stdout } = await _execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = /** @type {{ stderr?: string, message?: string }} */ (err);
    const detail = (e.stderr || '').trim() || e.message;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

export { git, GIT_IDENTITY };
