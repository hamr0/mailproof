// OpenTimestamps anchor (OPTIONAL). Spawns the `ots` CLI (python
// opentimestamps-client) to create a Bitcoin-anchored timestamp proof for a
// file. `ots stamp` writes a "pending" proof — a multi-calendar commitment
// that upgrades to a full Bitcoin proof within ~6 confirmations (~1h); the
// committed file IS that pending proof, and auditors run `ots upgrade` later.
//
// Config is INJECTED: createOts({ otsBin }) binds the `ots` binary path once
// and returns { stampFile }, matching the storage pillar's factory shape. Wire
// it into createGitrepo({ dataDir, ots }) only when anchoring is wanted; with
// no ots, the ledger writes unanchored commits (SPEC §0.2).
//
// Accept-with-flag: stampFile NEVER throws. It reports the outcome
// ({ proof_path } | { error }) so the caller records it in commit metadata and
// proceeds with delivery either way. Failure modes:
//   - `ots` binary missing           → { error: 'ots not found' }
//   - calendar/network down          → { error: 'ots exit N: …' }
//   - hang                           → { error: 'ots timeout' }

'use strict';

const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

function runOts(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const proc = spawn(bin, args);
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr, error: 'ots timeout' });
    }, timeoutMs);
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, error: err.code === 'ENOENT' ? 'ots not found' : err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function createOts({ otsBin, timeoutMs = 30000 } = {}) {
  if (!otsBin) throw new Error('createOts: otsBin required');

  // Stamp the file at `absPath`. `ots` writes `<absPath>.ots` next to it.
  // Returns { proof_path } on success, or { error } on any failure.
  async function stampFile(absPath) {
    const res = await runOts(otsBin, ['stamp', absPath], timeoutMs);
    if (res.error) return { error: res.error };
    if (res.code !== 0) return { error: `ots exit ${res.code}: ${res.stderr.trim().slice(0, 200)}` };
    const proof = absPath + '.ots';
    try {
      const st = await fs.stat(proof);
      if (!st.isFile()) return { error: 'ots proof file missing after stamp' };
      return { proof_path: proof };
    } catch {
      return { error: 'ots proof file missing after stamp' };
    }
  }

  return { stampFile };
}

module.exports = { createOts };
