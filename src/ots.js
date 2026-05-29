// OpenTimestamps anchor (OPTIONAL). Spawns the `ots` CLI (python
// opentimestamps-client) to create and complete a Bitcoin-anchored timestamp
// proof for a file. `ots stamp` writes a "pending" proof — a multi-calendar
// commitment that upgrades to a full Bitcoin proof within ~6 confirmations
// (~1h); the committed file IS that pending proof, and `upgradeProof` folds in
// the Bitcoin attestation once the calendars have it.
//
// Config is INJECTED: createOts({ otsBin }) binds the `ots` binary path once
// and returns { stampFile, upgradeProof, readBlockHeight }, matching the
// storage pillar's factory shape. Wire it into createGitrepo({ dataDir, ots })
// only when anchoring is wanted; with no ots, the ledger writes unanchored
// commits (SPEC §0.2).
//
// The verify half follows gitdone's proven worker (bin/ots-upgrade.js): we do
// NOT shell out to `ots verify` (which masks pending state by querying
// calendars live). Instead `upgradeProof` runs `ots upgrade` in place and
// treats the file's sha256 CHANGING as the authoritative "now anchored in
// Bitcoin" signal — the upgraded .ots then carries the attestation offline, and
// `readBlockHeight` (`ots info`, local parse, no network) reads which block.
// Recording the anchored state into the ledger + emitting the proof_anchored
// occasion is the consumer's scheduler (m7d), not this primitive.
//
// Accept-with-flag: nothing here NEVER throws. Each reports its outcome so the
// caller records it and proceeds either way. Failure modes:
//   - `ots` binary missing           → { error: 'ots not found' }
//   - calendar/network down          → { error: 'ots exit N: …' }
//   - hang                           → { error: 'ots timeout' }
// `ots upgrade` exits non-zero when a proof is still calendar-pending and
// nothing can be merged yet — that is NORMAL ({ pending: true }), not an error.

'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Parse the Bitcoin block height an .ots proof is anchored to, out of `ots
// info` stdout. PURE. opentimestamps-client has used a few output shapes over
// its lifetime; we accept the common ones and return the first match. Returns
// null when no anchor is present (calendar-only proof) or the format is
// unrecognised — callers degrade to "anchored to Bitcoin" without a number.
/**
 * Parse the Bitcoin block height out of `ots info` stdout, or null. Pure.
 * @param {string | null} stdout
 * @returns {number | null}
 */
function parseOtsBlockHeight(stdout) {
  if (!stdout) return null;
  const patterns = [
    /Bitcoin\s+block\s+(?:height\s+)?(\d+)/i,           // "Bitcoin block 850123"
    /Block\s+height[:\s]+(\d+)/i,                        // "Block height: 850123"
    /BitcoinBlockHeaderAttestation[^]*?\b(\d{6,})\b/i,   // attestation node + first 6+ digit run
  ];
  for (const re of patterns) {
    const m = stdout.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// sha256 of a file's bytes, or null if it can't be read. Used to detect whether
// `ots upgrade` rewrote the proof (= merged the Bitcoin attestation).
async function sha256OfFile(abs) {
  try {
    const buf = await fs.readFile(abs);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

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
      resolve({ code: -1, stdout, stderr, error: /** @type {any} */ (err).code === 'ENOENT' ? 'ots not found' : err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Bind an OpenTimestamps stamper to the `ots` binary. Each method reports its
 * outcome and never throws.
 * @param {{ otsBin?: string, timeoutMs?: number }} [opts]
 * @returns {{
 *   stampFile: (absPath: string) => Promise<{ proof_path: string } | { error: string }>,
 *   upgradeProof: (absPath: string) => Promise<{ ok: boolean, changed: boolean, anchored: boolean, pending: boolean, exit: number, block_height?: number | null, error?: string }>,
 *   readBlockHeight: (absPath: string) => Promise<number | null>,
 * }}
 */
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

  // Upgrade the proof at `absPath` IN PLACE: `ots upgrade` merges the Bitcoin
  // attestation from the calendars once it exists. Never throws. Returns:
  //   { ok, changed, anchored, pending, exit, block_height?, error? }
  // where
  //   changed  — the .ots bytes were rewritten this run = attestation merged now
  //   anchored — exit 0: the proof is fully Bitcoin-anchored (now, or already)
  //   pending  — exit non-zero with no spawn error: still calendar-only (normal)
  //   error    — only the binary itself failing (missing/timeout); not pending
  // On a successful anchor we also read the block height (offline `ots info`).
  async function upgradeProof(absPath) {
    const before = await sha256OfFile(absPath);
    const res = await runOts(otsBin, ['upgrade', absPath], timeoutMs);
    if (res.error) return { ok: false, changed: false, anchored: false, pending: false, exit: res.code, error: res.error };
    const after = await sha256OfFile(absPath);
    const changed = Boolean(before && after && before !== after);
    const anchored = res.code === 0;   // exit 0 ⇒ fully anchored (just now, or already)
    const pending = res.code !== 0;    // exit ≠0 ⇒ still calendar-pending — normal, not an error
    const out = { ok: true, changed, anchored, pending, exit: res.code };
    if (anchored) out.block_height = await readBlockHeight(absPath);
    return out;
  }

  // Read the Bitcoin block height the proof at `absPath` is anchored to, via
  // `ots info` (parses the binary proof LOCALLY — no network). Returns the
  // height, or null on any failure (binary missing, non-zero exit, parse miss).
  async function readBlockHeight(absPath) {
    const res = await runOts(otsBin, ['info', absPath], timeoutMs);
    if (res.error || res.code !== 0) return null;
    return parseOtsBlockHeight(res.stdout || '');
  }

  return { stampFile, upgradeProof, readBlockHeight };
}

module.exports = { createOts, parseOtsBlockHeight };
