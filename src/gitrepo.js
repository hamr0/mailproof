// Per-event git ledger. One repo per event at {dataDir}/repos/{eventId}/.
// Each accepted reply becomes a commit whose tree contains
// commits/commit-NNN.json with the SPEC §4 schema. The commit chain *is* the
// tamper-evidence and the portable, offline-verifiable proof.
//
// Config is INJECTED: createGitrepo({ dataDir, ots? }) binds the data dir once
// and returns the ledger primitives. `ots` is an OPTIONAL OpenTimestamps
// stamper ({ stampFile, moveProofIntoTree }); when omitted, commits are
// written without an anchor (ots_proof_file: null) per SPEC §0.2.
//
// git access is the stdlib `git` binary via child_process — no wrapper
// library, matching how outbound shells out to sendmail (DESIGN: "stdlib +
// git binary only"). simple-git was evaluated and rejected: gitrepo uses only
// init/config/add/commit/status, each a one-line execFile, well under the
// AGENT_RULES <100-line necessity bar. See the decisions log.
//
// Non-bare repo: the working tree IS the inspectable state of the event —
// `git clone` and read commits/* directly, no plumbing needed.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const _execFile = promisify(execFile);

const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;
// Git author for ledger commits. Cosmetic — the proof is the commit chain and
// its content, not the author. Neutral + non-routable (RFC 2606 .invalid).
const GIT_IDENTITY = { name: 'mailproof', email: 'noreply@mailproof.invalid' };

// Run a git subcommand in `cwd`; resolve trimmed stdout, reject with git's
// stderr on a non-zero exit. Outputs we read are tiny (a sha, a filename), so
// the default maxBuffer is ample — raised anyway for safety.
async function git(cwd, args) {
  try {
    const { stdout } = await _execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const detail = (err.stderr || '').trim() || err.message;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function dirExists(p) {
  try { return (await fs.stat(p)).isDirectory(); }
  catch { return false; }
}

async function readFileSafe(p) {
  try { return await fs.readFile(p, 'utf8'); }
  catch { return null; }
}

function padSeq(n) { return String(n).padStart(3, '0'); }

// SPEC §0.1 (plaintext discipline): commit payloads record a salted hash of
// the sender address, never the plaintext. Salt is a per-event public random
// value stored in event.json — verifiers re-hash a claimed address with the
// event's salt and match; observers can't bulk rainbow-table across events.
function saltedSenderHash(sender, salt) {
  if (!sender) return null;
  const material = `${salt || ''}|${sender.toLowerCase()}`;
  return `sha256:${sha256Hex(material)}`;
}

// Normalise a Message-ID before hashing. RFC 5322 defines it as an opaque
// value in angle brackets; treat case-insensitively for match stability.
function normaliseMessageId(mid) {
  if (!mid) return null;
  return String(mid).trim().replace(/^<|>$/g, '').toLowerCase();
}

function saltedMessageIdHash(mid, salt) {
  const n = normaliseMessageId(mid);
  if (!n) return null;
  return `sha256:${sha256Hex(`${salt || ''}|${n}`)}`;
}

function buildCommitMetadata(seq, ctx, event) {
  const sender = ctx.envelope && ctx.envelope.sender ? ctx.envelope.sender
    : (ctx.from || null);
  const senderDomain = sender && sender.includes('@') ? sender.split('@')[1] : null;
  const salt = (event && event.salt) || null;
  return {
    schema_version: 2,
    kind: 'reply',
    event_id: ctx.eventId,
    step_id: ctx.stepId || null,
    sequence: seq,
    received_at: ctx.receivedAt,
    sender_hash: saltedSenderHash(sender, salt),
    sender_domain: senderDomain,
    // Salted Message-ID hash enables re-matching a forwarded .eml even when
    // the forwarding client re-encoded the bytes; Message-ID is preserved
    // verbatim across any mail path per RFC 5322.
    message_id_hash: saltedMessageIdHash(ctx.messageId, salt),
    trust_level: ctx.trustLevel,
    participant_match: ctx.participantMatch,
    // Accept-with-flag (SPEC §4): every reply is committed; `counted` records
    // whether it advanced state, `count_reason` why not (null when counted).
    // The orchestrator (ingest) computes these from the engine's decision
    // before the commit is written; invariant: counted ⇒ count_reason null.
    counted: !!ctx.counted,
    count_reason: ctx.counted ? null : (ctx.count_reason || null),
    attachments: ctx.attachments || [],
    dkim: ctx.dkim || null,
    spf: ctx.spf || null,
    dmarc: ctx.dmarc || null,
    arc: ctx.arc || null,
    envelope: {
      client_ip: ctx.envelope && ctx.envelope.client_ip || null,
      client_helo: ctx.envelope && ctx.envelope.client_helo || null,
    },
    raw_sha256: ctx.rawSha256,
    raw_size: ctx.rawSize,
    // Populated after writing when archival/anchoring apply.
    dkim_key_file: null,
    ots_proof_file: null,
  };
}

// Bind a ledger to a fixed data directory (and optional OTS stamper).
function createGitrepo({ dataDir, ots = null } = {}) {
  if (!dataDir) throw new Error('createGitrepo: dataDir required');

  const repoPath = (eventId) => path.join(dataDir, 'repos', eventId);
  const writeJson = (abs, obj) => fs.writeFile(abs, JSON.stringify(obj, null, 2) + '\n');

  // Optionally OTS-stamp a finalised JSON file in place. Sets
  // metadata.ots_proof_file to the in-tree proof path on success (and pushes
  // it onto filesToAdd), or records ots_archive.error and leaves the path
  // null on failure. No-op when no OTS stamper is wired.
  async function maybeStamp(abs, root, proofRel, metadata, filesToAdd) {
    if (!ots) return; // unanchored: ots_proof_file stays null
    metadata.ots_proof_file = proofRel;
    await writeJson(abs, metadata); // stamp the bytes we actually commit
    const stampRes = await ots.stampFile(abs);
    if (stampRes && stampRes.proof_path) {
      await fs.rename(stampRes.proof_path, path.join(root, proofRel));
      filesToAdd.push(proofRel);
    } else {
      metadata.ots_proof_file = null;
      metadata.ots_archive = { error: (stampRes && stampRes.error) || 'ots stamp failed' };
      await writeJson(abs, metadata);
    }
  }

  async function initRepoIfNeeded(eventId, event) {
    if (!EVENT_ID_RE.test(eventId)) throw new Error(`invalid eventId: ${eventId}`);
    const root = repoPath(eventId);
    if (await dirExists(path.join(root, '.git'))) return { root, initialised: false };

    await fs.mkdir(path.join(root, 'commits'), { recursive: true });
    await fs.mkdir(path.join(root, 'dkim_keys'), { recursive: true });
    await fs.mkdir(path.join(root, 'ots_proofs'), { recursive: true });
    await writeJson(path.join(root, 'event.json'), event);
    // Can't commit empty dirs; .gitkeep makes the structure tracked.
    await Promise.all(['commits', 'dkim_keys', 'ots_proofs'].map(
      (d) => fs.writeFile(path.join(root, d, '.gitkeep'), '')
    ));

    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.name', GIT_IDENTITY.name]);
    await git(root, ['config', 'user.email', GIT_IDENTITY.email]);
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', `event created: ${event.title || eventId}`]);

    return { root, initialised: true };
  }

  // Highest commit-NNN.json sequence + 1 (1 on an empty/absent commits dir).
  async function nextSequence(root) {
    let files;
    try { files = await fs.readdir(path.join(root, 'commits')); }
    catch { return 1; }
    let max = 0;
    for (const f of files) {
      const m = f.match(/^commit-(\d+)\.json$/);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
    return max + 1;
  }

  async function commitReply(eventId, event, ctx) {
    const { root } = await initRepoIfNeeded(eventId, event);
    const seq = await nextSequence(root);
    const seqStr = padSeq(seq);
    const rel = path.join('commits', `commit-${seqStr}.json`);
    const abs = path.join(root, rel);

    const metadata = buildCommitMetadata(seq, ctx, event);
    const filesToAdd = [rel];

    // Durable DKIM-key archive: if the caller supplied the signing PEM, store
    // it alongside the commit so verification survives DNS key rotation.
    if (ctx.dkimArchive && ctx.dkimArchive.pem) {
      const keyRel = path.join('dkim_keys', `commit-${seqStr}.pem`);
      await fs.writeFile(path.join(root, keyRel), ctx.dkimArchive.pem);
      metadata.dkim_key_file = keyRel;
      metadata.dkim_archive = {
        fetched_at: ctx.dkimArchive.fetched_at || null,
        lookup: ctx.dkimArchive.lookup || null,
      };
      filesToAdd.push(keyRel);
    } else if (ctx.dkimArchive && ctx.dkimArchive.error) {
      metadata.dkim_archive = { error: ctx.dkimArchive.error };
    }

    await writeJson(abs, metadata);
    await maybeStamp(abs, root, path.join('ots_proofs', `commit-${seqStr}.ots`), metadata, filesToAdd);

    await git(root, ['add', ...filesToAdd]);
    const stepPart = ctx.stepId ? ` step ${ctx.stepId}` : '';
    await git(root, ['commit', '-m', `reply ${seqStr}: ${eventId}${stepPart} from ${metadata.sender_domain || 'unknown'}`]);

    return {
      sha: await git(root, ['rev-parse', 'HEAD']),
      sequence: seq,
      file: rel,
      dkim_key_file: metadata.dkim_key_file,
      ots_proof_file: metadata.ots_proof_file,
      repo_path: root,
    };
  }

  // Append an audit-trail commit recording an organiser-driven edit on an
  // activated event. Participant changes are stored as before/after salted
  // hashes (SPEC §0.1); other fields (deadline, title, …) are non-PII plaintext.
  async function appendEditCommit(eventId, editCtx, event) {
    const { root } = await initRepoIfNeeded(eventId, event);
    const seq = await nextSequence(root);
    const seqStr = padSeq(seq);
    const rel = path.join('commits', `commit-${seqStr}.json`);
    const abs = path.join(root, rel);

    const salt = event.salt;
    const changes = (editCtx.changes || []).map((c) => {
      if (c.field === 'participant') {
        return {
          step_id: c.step_id,
          field: 'participant',
          from_hash: saltedSenderHash(c.from, salt),
          to_hash: saltedSenderHash(c.to, salt),
        };
      }
      return c;
    });

    const metadata = {
      schema_version: 1,
      sequence: seq,
      kind: 'event_edit',
      event_id: eventId,
      edited_at: editCtx.edited_at,
      organiser_handle: editCtx.organiser_handle || null,
      changes,
      ots_proof_file: null,
    };
    const filesToAdd = [rel];

    await writeJson(abs, metadata);
    await maybeStamp(abs, root, path.join('ots_proofs', `commit-${seqStr}.ots`), metadata, filesToAdd);

    await git(root, ['add', ...filesToAdd]);
    await git(root, ['commit', '-m', `edit: ${changes.length} change${changes.length === 1 ? '' : 's'} on ${eventId}`]);

    return {
      sequence: seq,
      sha: await git(root, ['rev-parse', 'HEAD']),
      file: rel,
      ots_proof_file: metadata.ots_proof_file,
      repo_path: root,
    };
  }

  // Write the one-shot completion record (SPEC §4): `commits/completion.json`,
  // committed once when the event reaches `complete`. Idempotent — a second
  // call returns { alreadyWritten } without a new commit. Records the
  // `completed_at` and the `triggering_commit_sequence` (the reply that tipped
  // it). gitdone's per-mode `event_mode` is dropped — the two-mode model has no
  // `mode`; `event_type` ("workflow" | "crypto") is enough.
  async function commitCompletion(eventId, event, completionCtx = {}) {
    const { root } = await initRepoIfNeeded(eventId, event);
    const rel = path.join('commits', 'completion.json');
    const abs = path.join(root, rel);
    if (await readFileSafe(abs)) return { alreadyWritten: true, file: rel };

    const metadata = {
      schema_version: 1,
      kind: 'completion',
      event_id: eventId,
      event_type: event.type || null,
      completed_at: completionCtx.completedAt || null,
      triggering_commit_sequence: completionCtx.triggeringSequence != null
        ? completionCtx.triggeringSequence : null,
      summary: completionCtx.summary || null,
      ots_proof_file: null,
    };
    const filesToAdd = [rel];

    await writeJson(abs, metadata);
    await maybeStamp(abs, root, path.join('ots_proofs', 'completion.ots'), metadata, filesToAdd);

    await git(root, ['add', ...filesToAdd]);
    await git(root, ['commit', '-m', `completion: ${eventId} complete`]);

    return {
      alreadyWritten: false,
      sha: await git(root, ['rev-parse', 'HEAD']),
      file: rel,
      ots_proof_file: metadata.ots_proof_file,
      repo_path: root,
    };
  }

  // Load a committed reply by sequence number (null if missing/unparseable).
  // Read an archived DKIM public key (PEM) by its commit-relative path (the
  // `dkim_key_file` recorded on the commit, e.g. 'dkim_keys/commit-001.pem').
  // The offline verifier re-runs DKIM against this. Path is allowlisted to the
  // dkim_keys/ dir so a crafted commit can't read arbitrary files. Returns the
  // PEM string or null.
  async function loadDkimPem(eventId, relPath) {
    if (!EVENT_ID_RE.test(eventId) || !relPath) return null;
    if (!/^dkim_keys\/commit-\d+\.pem$/.test(relPath)) return null;
    return readFileSafe(path.join(repoPath(eventId), relPath));
  }

  async function loadCommit(eventId, sequence) {
    if (!EVENT_ID_RE.test(eventId)) throw new Error(`invalid eventId: ${eventId}`);
    const abs = path.join(repoPath(eventId), 'commits', `commit-${padSeq(sequence)}.json`);
    const raw = await readFileSafe(abs);
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch { return null; }
  }

  // List all reply commits under an event, ordered by sequence ascending.
  // Reads the filesystem (not `git log`) — surfaces replies committed for
  // audit even when they didn't count.
  async function listCommits(eventId) {
    if (!EVENT_ID_RE.test(eventId)) return [];
    let files;
    try { files = await fs.readdir(path.join(repoPath(eventId), 'commits')); }
    catch { return []; }
    const seqs = [];
    for (const f of files) {
      const m = f.match(/^commit-(\d+)\.json$/);
      if (m) seqs.push(parseInt(m[1], 10));
    }
    seqs.sort((a, b) => a - b);
    const out = [];
    for (const seq of seqs) {
      const c = await loadCommit(eventId, seq);
      if (c) out.push(c);
    }
    return out;
  }

  // Sync the per-event repo's working-tree event.json with the master event
  // JSON. The repo IS the proof artifact: once a repo exists, every state
  // transition must also land here or the offline verifier reads a stale
  // snapshot. No-op when there's no repo, or when the bytes match HEAD.
  //
  // The no-change check is BYTE-STRICT (git's own staged detection): every
  // writer of event.json MUST use `JSON.stringify(event, null, 2) + '\n'` so
  // an unchanged event re-syncs to nothing staged. Drift in serialization
  // (indent, key order, trailing newline) produces spurious ledger commits;
  // the integration test pins both directions.
  async function syncEventJson(eventId, event, message) {
    if (!EVENT_ID_RE.test(eventId)) throw new Error(`invalid eventId: ${eventId}`);
    const root = repoPath(eventId);
    if (!await dirExists(path.join(root, '.git'))) return { synced: false, reason: 'no_repo' };

    await writeJson(path.join(root, 'event.json'), event);
    await git(root, ['add', 'event.json']);
    // `git diff --cached --name-only` lists files staged vs HEAD. If event.json
    // was byte-identical to HEAD's, nothing is staged — skip the commit.
    const staged = (await git(root, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
    if (!staged.includes('event.json')) {
      return { synced: false, reason: 'no_change' };
    }
    await git(root, ['commit', '-m', message || 'event state update']);
    return { synced: true, sha: await git(root, ['rev-parse', 'HEAD']) };
  }

  return {
    repoPath,
    initRepoIfNeeded,
    nextSequence,
    commitReply,
    appendEditCommit,
    commitCompletion,
    loadCommit,
    loadDkimPem,
    listCommits,
    syncEventJson,
    // Pure helpers (no dataDir), exposed for convenience.
    buildCommitMetadata,
    saltedSenderHash,
    saltedMessageIdHash,
    normaliseMessageId,
  };
}

module.exports = { createGitrepo };
