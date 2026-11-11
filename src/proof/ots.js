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


import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

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
  ];
  for (const re of patterns) {
    const m = stdout.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // Attestation node + the first 6+ digit run after it. Written as a search from the FIRST
  // node, not as `Attestation[^]*?\b(\d{6,})\b`: that rescans to the end from every node
  // when no digit run follows (quadratic). If the first node has no run after it, no later
  // node can, so one search is the same answer. The sticky-style lastIndex keeps `\b` aware
  // of the character before the start, as the single regex was.
  const node = /BitcoinBlockHeaderAttestation/i.exec(stdout);
  if (node) {
    const run = /\b(\d{6,})\b/g;
    run.lastIndex = node.index + node[0].length;
    const m = run.exec(stdout);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

const OTS_DIGEST_RE = /^File sha256 hash: ([0-9a-f]{64})\s*$/;
const OTS_BLOCK_RE = /^[\s>-]*verify BitcoinBlockHeaderAttestation\((\d+)\)\s*$/;
const OTS_ROOT_RE = /^[\s>-]*# Bitcoin block merkle root ([0-9a-f]{64})\s*$/;
const OTS_PENDING_RE = /^[\s>-]*verify PendingAttestation\(/;

/**
 * Parse `ots info <file.ots>` stdout (SPEC B13.3.4): the digest the proof commits to and its attestations. The one place that
 * reads this output for `verify-bundle`. Line-anchored per line (a leading tree indent or `->` is tolerated: a proof with
 * several branches prints its attestations indented). `anchored` wins over `pending` when both are present (an upgraded proof
 * keeps its calendar path). Null when there is no digest line or no attestation line. Pure; never throws.
 * @param {string | null} stdout
 * @returns {{ digest: string, block: number | null, merkleRoot: string | null, pending: boolean } | null}
 */
function parseOtsInfo(stdout) {
  if (!stdout) return null;
  /** @type {string | null} */
  let digest = null;
  /** @type {number | null} */
  let block = null;
  /** @type {string | null} */
  let merkleRoot = null;
  let pending = false;
  for (const line of stdout.split('\n')) {
    const d = OTS_DIGEST_RE.exec(line);
    if (d) { if (digest === null) digest = d[1]; continue; }
    const b = OTS_BLOCK_RE.exec(line);
    if (b) { if (block === null) { const n = Number(b[1]); if (Number.isSafeInteger(n) && n > 0) block = n; } continue; }
    const r = OTS_ROOT_RE.exec(line);
    if (r) { if (merkleRoot === null) merkleRoot = r[1]; continue; }
    if (OTS_PENDING_RE.test(line)) pending = true;
  }
  if (digest === null || (block === null && !pending)) return null;
  return { digest, block, merkleRoot: block === null ? null : merkleRoot, pending: block === null && pending };
}

/**
 * `ots info <proof>` as `verify-bundle` runs it (SPEC B13.3.2): an argument vector (no shell), a time limit, output capped; a
 * parse of the proof on this machine, no network. Never throws: every outcome is a field.
 * @param {string} bin
 * @param {string} proofPath
 * @param {{ timeoutMs: number, maxBytes: number }} limits
 * @returns {Promise<{ info: ReturnType<typeof parseOtsInfo> } | { error: 'ots not found' | 'ots timeout' | 'ots output over limit' | string }>}
 */
function infoProof(bin, proofPath, { timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    let size = 0;
    let done = false;
    /** @param {Parameters<typeof resolve>[0]} v */
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const proc = spawn(bin, ['info', proofPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); finish({ error: 'ots timeout' }); }, timeoutMs);
    proc.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { proc.kill('SIGKILL'); finish({ error: 'ots output over limit' }); return; }
      out.push(c);
    });
    proc.on('error', (err) => finish({ error: /** @type {any} */ (err).code === 'ENOENT' ? 'ots not found' : err.message }));
    proc.on('close', (code) => finish(code === 0 ? { info: parseOtsInfo(Buffer.concat(out).toString('utf8')) } : { info: null }));
  });
}

// sha256 of a file's bytes, or null if it can't be read. Used to detect whether
// `ots upgrade` rewrote the proof (= merged the Bitcoin attestation).
/**
 * @param {string} abs
 * @returns {Promise<string | null>}
 */
async function sha256OfFile(abs) {
  try {
    const buf = await fs.readFile(abs);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number, stdout: string, stderr: string, error?: string }>}
 */
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
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Default per-command timeout for the `ots` binary (ms). */
const DEFAULT_OTS_TIMEOUT_MS = 30000;

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
function createOts({ otsBin, timeoutMs = DEFAULT_OTS_TIMEOUT_MS } = {}) {
  if (!otsBin) throw new Error('createOts: otsBin required');
  const bin = otsBin;

  // Stamp the file at `absPath`. `ots` writes `<absPath>.ots` next to it.
  // Returns { proof_path } on success, or { error } on any failure.
  /**
   * @param {string} absPath
   * @returns {Promise<{ proof_path: string } | { error: string }>}
   */
  async function stampFile(absPath) {
    const res = await runOts(bin, ['stamp', absPath], timeoutMs);
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
  /**
   * @param {string} absPath
   * @returns {Promise<{ ok: boolean, changed: boolean, anchored: boolean, pending: boolean, exit: number, block_height?: number | null, error?: string }>}
   */
  async function upgradeProof(absPath) {
    const before = await sha256OfFile(absPath);
    const res = await runOts(bin, ['upgrade', absPath], timeoutMs);
    if (res.error) return { ok: false, changed: false, anchored: false, pending: false, exit: res.code, error: res.error };
    const after = await sha256OfFile(absPath);
    const changed = Boolean(before && after && before !== after);
    const anchored = res.code === 0;   // exit 0 ⇒ fully anchored (just now, or already)
    const pending = res.code !== 0;    // exit ≠0 ⇒ still calendar-pending — normal, not an error
    /** @type {{ ok: boolean, changed: boolean, anchored: boolean, pending: boolean, exit: number, block_height?: number | null }} */
    const out = { ok: true, changed, anchored, pending, exit: res.code };
    if (anchored) out.block_height = await readBlockHeight(absPath);
    return out;
  }

  // Read the Bitcoin block height the proof at `absPath` is anchored to, via
  // `ots info` (parses the binary proof LOCALLY — no network). Returns the
  // height, or null on any failure (binary missing, non-zero exit, parse miss).
  /**
   * @param {string} absPath
   * @returns {Promise<number | null>}
   */
  async function readBlockHeight(absPath) {
    const res = await runOts(bin, ['info', absPath], timeoutMs);
    if (res.error || res.code !== 0) return null;
    return parseOtsBlockHeight(res.stdout || '');
  }

  return { stampFile, upgradeProof, readBlockHeight };
}

/** The one plain message for a missing `ots` binary (StampResult.error, CLI output): capture is never blocked by it. */
const OTS_MISSING_MESSAGE = 'ots not installed: records are not sealed; install opentimestamps-client or set ots: false';

export { OTS_MISSING_MESSAGE, DEFAULT_OTS_TIMEOUT_MS, createOts, parseOtsBlockHeight, parseOtsInfo, infoProof };
