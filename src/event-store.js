// Event JSON store. Loads and persists events from disk by ID. Schema follows
// SPEC §4. Storage layout: {dataDir}/events/{eventId}.json
//
// Config is INJECTED, not read from a singleton: createEventStore({ dataDir })
// binds the data directory once and returns the store primitives. `dataDir`
// thus lives in exactly one place (the create call) — see the decisions log,
// "Config injection by bound per-pillar factories."
//
// Defensive against path traversal via a strict eventId allowlist
// (alphanumeric only).

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { withEventMutex } = require('./event-mutex');

const EVENT_ID_RE = /^[a-zA-Z0-9]+$/;
const ALLOWED_STEP_FIELDS = ['participant', 'deadline', 'requires_attachment', 'details'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- Pure helpers (no dataDir needed; bound into the store for convenience) ---

function findStep(event, stepId) {
  if (!event || !Array.isArray(event.steps) || !stepId) return null;
  return event.steps.find((s) => s && s.id === stepId) || null;
}

function normaliseEmail(addr) {
  return (addr || '').trim().toLowerCase();
}

function senderMatchesStep(senderAddr, step) {
  if (!step || !step.participant) return false;
  return normaliseEmail(senderAddr) === normaliseEmail(step.participant);
}

// Generate a short, url-safe, alphanumeric event ID. 8 random bytes → base36,
// trimmed to 12 chars — reads well in URLs and email plus-tags, with ample
// entropy for uniqueness across expected volume.
function generateEventId() {
  const n = BigInt('0x' + crypto.randomBytes(8).toString('hex'));
  return n.toString(36).padStart(12, '0').slice(0, 12);
}

// Generate an event's public salt (per-event 32 bytes hex) used to salt the
// sender_hash and message_id_hash in commit metadata (SPEC §0.1).
function generateEventSalt() {
  return crypto.randomBytes(32).toString('hex');
}

// Apply a partial patch to an event, returning { next, changes }. Pure — no
// I/O. Patch shape:
//   { title?: string, steps?: [{ id, participant?, deadline?,
//     requires_attachment?, details? }, ...] }
//
// Validation:
//   - Only steps with status !== 'complete' are editable. Editing a completed
//     step throws EVENT_STEP_FROZEN — the audit-trail commit for a completed
//     step records what its participant was at reply time; rewriting it lies.
//   - Step ids in the patch must exist on the event.
//   - participant: must be a valid email shape (basic).
//   - deadline: 'YYYY-MM-DD' or empty string (clears the deadline).
//   - requires_attachment: coerced to boolean.
//   - details: string (no length cap here; the caller's form already caps).
//   - title: any non-empty string.
//
// Returns the new event object and an array of change records:
//   [{ step_id, field, from, to }, ...]   (step_id is null for title)
function _applyEditPatch(event, patch) {
  if (!patch || typeof patch !== 'object') {
    throw Object.assign(new Error('editEvent: patch object required'), { code: 'BAD_PATCH' });
  }
  const changes = [];
  const next = { ...event, steps: Array.isArray(event.steps) ? event.steps.map((s) => ({ ...s })) : event.steps };

  if (Object.prototype.hasOwnProperty.call(patch, 'title')) {
    const newTitle = String(patch.title || '').trim();
    if (!newTitle) {
      throw Object.assign(new Error('editEvent: title cannot be empty'), { code: 'BAD_TITLE' });
    }
    if (newTitle !== event.title) {
      changes.push({ step_id: null, field: 'title', from: event.title, to: newTitle });
      next.title = newTitle;
    }
  }

  if (Array.isArray(patch.steps)) {
    for (const sp of patch.steps) {
      if (!sp || !sp.id) continue;
      const idx = next.steps.findIndex((s) => s.id === sp.id);
      if (idx < 0) {
        throw Object.assign(new Error(`editEvent: step ${sp.id} not found`), { code: 'STEP_NOT_FOUND' });
      }
      const cur = next.steps[idx];
      if (cur.status === 'complete') {
        throw Object.assign(new Error(`editEvent: step ${sp.id} is complete and cannot be edited`), { code: 'EVENT_STEP_FROZEN' });
      }
      const merged = { ...cur };
      for (const f of ALLOWED_STEP_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(sp, f)) continue;
        let value = sp[f];
        if (f === 'participant') {
          value = String(value || '').trim();
          if (!EMAIL_RE.test(value)) {
            throw Object.assign(new Error(`editEvent: invalid email for step ${sp.id}`), { code: 'BAD_EMAIL' });
          }
        } else if (f === 'deadline') {
          value = value == null ? '' : String(value).trim();
          if (value && !DATE_RE.test(value)) {
            throw Object.assign(new Error(`editEvent: deadline must be YYYY-MM-DD on step ${sp.id}`), { code: 'BAD_DEADLINE' });
          }
          if (!value) value = undefined; // normalise empty → terse JSON
        } else if (f === 'requires_attachment') {
          value = !!value;
        } else if (f === 'details') {
          value = value == null ? '' : String(value);
          if (!value) value = undefined;
        }
        const before = cur[f];
        if (before !== value) {
          changes.push({ step_id: sp.id, field: f, from: before == null ? null : before, to: value == null ? null : value });
          if (value === undefined) delete merged[f];
          else merged[f] = value;
          // A participant edit invalidates any previous last_send_error: the
          // re-notify will write a fresh outcome, and a stale error would make
          // "did my fix land?" indistinguishable from "did the new send fail?".
          if (f === 'participant') delete merged.last_send_error;
        }
      }
      next.steps[idx] = merged;
    }
  }

  return { next, changes };
}

// Bind a store to a fixed data directory. All disk-touching primitives close
// over `dataDir`; pure helpers are returned as-is for convenience.
// Expand the `flow` sugar into the canonical per-step `dependsOn` graph the
// engine reads (SPEC §3). The engine has ONE eligibility model (dependsOn), so
// `flow` exists only at creation: `sequential` → a linear chain (each step
// depends on the prior), `parallel` → no deps, `custom` → the caller's
// `dependsOn` kept verbatim. Per-step lifecycle defaults (status,
// commit_sequence) are filled idempotently. Pure.
function expandFlow(steps, flow) {
  const list = Array.isArray(steps) ? steps : [];
  return list.map((s, i) => {
    let dependsOn;
    if (flow === 'parallel') dependsOn = [];
    else if (flow === 'custom') dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    else dependsOn = i === 0 ? [] : [list[i - 1].id]; // sequential (default)
    return { status: 'pending', commit_sequence: null, ...s, dependsOn };
  });
}

// Normalize a caller's partial event into the canonical record both engines
// read — branching on `type` (SPEC §3 workflow / §3.1 crypto). Pure (no I/O);
// `createEvent` wraps it with the collision check + atomic write. Validation is
// structural only (mechanism, not policy): it rejects records that could never
// behave — an unknown type, a workflow step without a unique id, a crypto event
// with threshold < 1 or with neither `signers` nor `open` (nothing could ever
// count).
function buildEventRecord(partialEvent, { now = new Date().toISOString() } = {}) {
  if (!partialEvent || typeof partialEvent !== 'object') {
    throw new Error('createEvent: event object required');
  }
  const id = partialEvent.id || generateEventId();
  if (!EVENT_ID_RE.test(id)) {
    throw new Error(`createEvent: invalid id '${id}' (must be alphanumeric)`);
  }
  const type = partialEvent.type || 'workflow';
  if (type !== 'workflow' && type !== 'crypto') {
    throw new Error(`createEvent: unknown type '${type}' (expected 'workflow' | 'crypto')`);
  }

  const base = {
    ...partialEvent,
    id,
    type,
    created_at: partialEvent.created_at || now,
    salt: partialEvent.salt || generateEventSalt(),
    status: partialEvent.status || 'open',
    activated_at: partialEvent.activated_at || null,
    completed_at: partialEvent.completed_at || null,
    archived_at: partialEvent.archived_at || null,
  };

  if (type === 'workflow') {
    const flow = partialEvent.flow || 'sequential';
    const steps = Array.isArray(partialEvent.steps) ? partialEvent.steps : [];
    const ids = steps.map((s) => s && s.id);
    if (ids.some((x) => !x)) throw new Error('createEvent: every workflow step needs an id');
    if (new Set(ids).size !== ids.length) throw new Error('createEvent: workflow step ids must be unique');
    return { ...base, flow, steps: expandFlow(steps, flow) };
  }

  // type === 'crypto'
  const threshold = partialEvent.threshold == null ? 1 : partialEvent.threshold;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`createEvent: crypto threshold must be an integer >= 1 (got ${partialEvent.threshold})`);
  }
  const open = !!partialEvent.open;
  const signers = Array.isArray(partialEvent.signers)
    ? partialEvent.signers.map((s) => String(s).toLowerCase()) : [];
  if (!open && signers.length === 0) {
    throw new Error('createEvent: a crypto event needs `signers` or `open: true` (nothing could ever count)');
  }
  return {
    ...base,
    signers,
    open,
    threshold,
    requiredDocHash: partialEvent.requiredDocHash || null,
    signatures: Array.isArray(partialEvent.signatures) ? partialEvent.signatures : [],
  };
}

function createEventStore({ dataDir } = {}) {
  if (!dataDir) throw new Error('createEventStore: dataDir required');

  const eventsDir = path.join(dataDir, 'events');
  const eventFile = (id) => path.join(eventsDir, `${id}.json`);

  // Atomic write: temp file in the same dir, then rename.
  async function writeEventAtomic(id, event) {
    const file = eventFile(id);
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(event, null, 2) + '\n');
    await fs.rename(tmp, file);
  }

  // Lazily bind a gitrepo to the SAME dataDir. gitrepo is the other half of
  // the storage pillar (module 5b); event-store calls into it when an
  // *activated* event mutates so the change is tamper-evident alongside
  // replies. Until 5b lands, requiring it throws — activateEvent swallows
  // that (sync is best-effort), and editEvent's activated path is covered by
  // a test deferred to 5b.
  let _gitrepo;
  function gitrepo() {
    if (!_gitrepo) _gitrepo = require('./gitrepo').createGitrepo({ dataDir });
    return _gitrepo;
  }

  async function loadEvent(eventId) {
    if (!eventId || !EVENT_ID_RE.test(eventId)) return null;
    try {
      const data = await fs.readFile(eventFile(eventId), 'utf8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // Persist a new event. The caller supplies the validated event shape; this
  // adds {id, created_at, salt, activated_at} and writes atomically. Events
  // are created pending (activated_at: null); a reply doesn't count until the
  // event is activated.
  async function createEvent(partialEvent) {
    // Normalize + validate (two-mode, flow→dependsOn) purely, then persist.
    const event = buildEventRecord(partialEvent);

    await fs.mkdir(eventsDir, { recursive: true });

    // Refuse to overwrite — an id collision is a real bug, not a silent update.
    try {
      await fs.stat(eventFile(event.id));
      throw new Error(`createEvent: event ${event.id} already exists`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await writeEventAtomic(event.id, event);
    return event;
  }

  // Mark an event activated. Idempotent: re-activating returns the existing
  // event with alreadyActive=true, so callers can gate one-shot side effects
  // (participant notifications) on the first transition only. Serialised
  // through the per-event mutex so two concurrent activations can't both
  // observe !activated_at.
  async function activateEvent(eventId, { now = new Date().toISOString() } = {}) {
    return withEventMutex(eventId, async () => {
      const event = await loadEvent(eventId);
      if (!event) throw new Error(`activateEvent: event ${eventId} not found`);
      if (event.activated_at) return { event, alreadyActive: true };
      const next = { ...event, activated_at: now };
      await writeEventAtomic(eventId, next);
      // The repo usually doesn't exist yet on activation (init happens on
      // first reply/commit), so this no-ops — but if a future path pre-creates
      // it, this keeps the repo's event.json in step. Best-effort.
      try {
        await gitrepo().syncEventJson(eventId, next, 'event activated');
      } catch { /* sync failure shouldn't block activation */ }
      return { event: next, alreadyActive: false };
    });
  }

  // Patch an event in place. For activated events, also writes an audit commit
  // to the per-event git repo so the change is tamper-evident like replies.
  // For pending events (no repo yet), the edit is a plain event.json mutation.
  //
  // Throws on finalised events (EVENT_COMPLETE / EVENT_ARCHIVED), patches that
  // touch a completed step (EVENT_STEP_FROZEN), and invalid values (BAD_EMAIL,
  // BAD_DEADLINE, BAD_TITLE). Returns { event, prev, changes, commitSequence };
  // commitSequence is the audit commit number (null for pending-event edits).
  async function editEvent(eventId, patch, { now = new Date().toISOString(), organiserHandle = null } = {}) {
    return withEventMutex(eventId, async () => {
      const event = await loadEvent(eventId);
      if (!event) throw Object.assign(new Error(`editEvent: ${eventId} not found`), { code: 'NOT_FOUND' });
      if (event.completion && event.completion.status === 'complete') {
        throw Object.assign(new Error('editEvent: event is complete'), { code: 'EVENT_COMPLETE' });
      }
      if (event.archived_at) {
        throw Object.assign(new Error('editEvent: event is archived'), { code: 'EVENT_ARCHIVED' });
      }
      const { next, changes } = _applyEditPatch(event, patch);
      if (changes.length === 0) {
        return { event, prev: event, changes: [], commitSequence: null };
      }
      await writeEventAtomic(eventId, next);

      let commitSequence = null;
      if (event.activated_at) {
        const repo = gitrepo();
        const result = await repo.appendEditCommit(eventId, {
          edited_at: now,
          organiser_handle: organiserHandle,
          changes,
        }, next);
        commitSequence = result.sequence;
        // Mirror the post-edit master state into the repo's event.json so the
        // proof artifact reflects the new participant list / deadline / title.
        const summary = changes.map((c) => c.field).filter(Boolean).join(', ') || 'edit';
        try {
          await repo.syncEventJson(eventId, next, `event edited: ${summary}`);
        } catch { /* sync failure shouldn't undo the edit */ }
      }

      return { event: next, prev: event, changes, commitSequence };
    });
  }

  // Persist per-step send-error flags after an outbound notification batch.
  // `errorsByStepId` is { [stepId]: { reason, code, at } | null }; null clears
  // any previous error. Steps absent from the map are untouched. Returns the
  // updated event, or null if it no longer exists. Never throws on a missing
  // step id — outbound notifications and the event JSON are decoupled.
  async function recordStepSendErrors(eventId, errorsByStepId) {
    if (!errorsByStepId || typeof errorsByStepId !== 'object') return null;
    const ids = Object.keys(errorsByStepId);
    if (ids.length === 0) return null;
    return withEventMutex(eventId, async () => {
      const event = await loadEvent(eventId);
      if (!event || !Array.isArray(event.steps)) return null;
      let dirty = false;
      const nextSteps = event.steps.map((s) => {
        if (!s || !Object.prototype.hasOwnProperty.call(errorsByStepId, s.id)) return s;
        const err = errorsByStepId[s.id];
        const cur = s.last_send_error;
        if (err == null) {
          if (cur == null) return s;
          const { last_send_error, ...rest } = s;
          dirty = true;
          return rest;
        }
        // Shallow equality is enough — the field is set by us and only us.
        if (cur && cur.reason === err.reason && cur.code === err.code && cur.at === err.at) {
          return s;
        }
        dirty = true;
        return { ...s, last_send_error: err };
      });
      if (!dirty) return event;
      const next = { ...event, steps: nextSteps };
      await writeEventAtomic(eventId, next);
      return next;
    });
  }

  // Persist the Message-Id of the completion proof email so an OTS-anchored
  // follow-up can thread to it. Idempotent: a non-null existing value is left
  // untouched (the FIRST proof email is the canonical thread root). Returns
  // the post-write value.
  async function recordProofEmailMessageId(eventId, messageId) {
    if (!messageId) return null;
    return withEventMutex(eventId, async () => {
      const event = await loadEvent(eventId);
      if (!event) return null;
      if (event.proof_email_message_id) return event.proof_email_message_id;
      const next = { ...event, proof_email_message_id: messageId };
      await writeEventAtomic(eventId, next);
      return messageId;
    });
  }

  return {
    loadEvent,
    findStep,
    senderMatchesStep,
    createEvent,
    activateEvent,
    editEvent,
    // Raw atomic overwrite of an existing event's master JSON. UNGUARDED — it
    // takes no mutex, so the caller MUST already hold withEventMutex(eventId).
    // ingest() needs this: the in-process mutex is non-reentrant, so ingest
    // holds the lock for its whole commit→advance→persist section and cannot
    // call the mutex-taking helpers (activateEvent/editEvent) from inside it.
    writeEventAtomic,
    recordStepSendErrors,
    recordProofEmailMessageId,
    generateEventId,
    generateEventSalt,
  };
}

module.exports = { createEventStore, buildEventRecord, expandFlow };
