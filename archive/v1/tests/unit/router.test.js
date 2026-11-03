
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as router from '../../src/router.js';
const {
  parseAddress, parseEventTag, parseVerifyTag, parseReverifyTag, parseAttestTag, parseInitiatorCommand,
} = router;

// --- parseAddress ---

test('parseAddress: standard event+tag form', () => {
  assert.deepEqual(parseAddress('event+abc123-step1@example.com'), {
    kind: 'event',
    extension: 'abc123-step1',
    domain: 'example.com',
  });
});

test('parseAddress: case-insensitive kind and domain, lowered', () => {
  const a = parseAddress('Event+abc-step1@Example.COM');
  assert.equal(a.kind, 'event');
  assert.equal(a.domain, 'example.com');
});

test('parseAddress: returns null on plain (no plus) address', () => {
  assert.equal(parseAddress('test@example.com'), null);
});

test('parseAddress: returns null on garbage / empty / nullish', () => {
  assert.equal(parseAddress('not an address'), null);
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress(null), null);
  assert.equal(parseAddress(undefined), null);
});

// --- parseEventTag ---

test('parseEventTag: extracts eventId and stepId', () => {
  assert.deepEqual(parseEventTag('event+abc123-step1@example.com'), { eventId: 'abc123', stepId: 'step1' });
});

test('parseEventTag: stepId may contain dashes (split on first dash only)', () => {
  assert.deepEqual(parseEventTag('event+abc-step-1-final@example.com'), { eventId: 'abc', stepId: 'step-1-final' });
});

test('parseEventTag: eventId without stepId is permitted', () => {
  assert.deepEqual(parseEventTag('event+abc123@example.com'), { eventId: 'abc123', stepId: null });
});

test('parseEventTag: rejects non-event kinds (incl. dropped policy tags)', () => {
  assert.equal(parseEventTag('manage+abc@example.com'), null);
  assert.equal(parseEventTag('attest+abc@example.com'), null);
});

test('parseEventTag: rejects non-alphanumeric eventId (path traversal guard)', () => {
  assert.equal(parseEventTag('event+../etc/passwd-step1@example.com'), null);
  assert.equal(parseEventTag('event+abc.123-step1@example.com'), null);
  assert.equal(parseEventTag('event+abc 123-step1@example.com'), null);
});

test('parseEventTag: returns null when address fails parse', () => {
  assert.equal(parseEventTag('plain@example.com'), null);
  assert.equal(parseEventTag(null), null);
});

// --- parseVerifyTag (kernel tag; not covered by gitdone's original suite) ---

test('parseVerifyTag: extracts eventId, no step component', () => {
  assert.deepEqual(parseVerifyTag('verify+abc123@example.com'), { eventId: 'abc123' });
  assert.deepEqual(parseVerifyTag('VERIFY+abc123@example.com'), { eventId: 'abc123' });
});

test('parseVerifyTag: rejects non-verify kinds and reverify (distinct tag)', () => {
  assert.equal(parseVerifyTag('event+abc123@example.com'), null);
  assert.equal(parseVerifyTag('reverify+abc123-3@example.com'), null);
});

test('parseVerifyTag: rejects non-alphanumeric / dashed eventId', () => {
  assert.equal(parseVerifyTag('verify+abc-3@example.com'), null);
  assert.equal(parseVerifyTag('verify+..@example.com'), null);
  assert.equal(parseVerifyTag('verify+@example.com'), null);
});

// --- parseAttestTag (kernel tag since the two-mode pivot) ---

test('parseAttestTag: extracts eventId, no step component', () => {
  assert.deepEqual(parseAttestTag('attest+abc123@example.com'), { eventId: 'abc123' });
  assert.deepEqual(parseAttestTag('ATTEST+abc123@example.com'), { eventId: 'abc123' });
});

test('parseAttestTag: rejects non-attest kinds and dashed/non-alphanumeric ids', () => {
  assert.equal(parseAttestTag('event+abc123@example.com'), null);
  assert.equal(parseAttestTag('verify+abc123@example.com'), null);
  assert.equal(parseAttestTag('attest+abc-123@example.com'), null);
  assert.equal(parseAttestTag('attest+..@example.com'), null);
  assert.equal(parseAttestTag('attest+@example.com'), null);
});

// --- parseReverifyTag ---

test('parseReverifyTag: extracts eventId and commitSequence', () => {
  assert.deepEqual(parseReverifyTag('reverify+demo123-3@example.com'), { eventId: 'demo123', commitSequence: 3 });
});

test('parseReverifyTag: multi-digit commit sequences', () => {
  assert.deepEqual(parseReverifyTag('reverify+demo-42@example.com'), { eventId: 'demo', commitSequence: 42 });
});

test('parseReverifyTag: rejects non-reverify kinds', () => {
  assert.equal(parseReverifyTag('verify+demo123@example.com'), null);
  assert.equal(parseReverifyTag('event+demo123-3@example.com'), null);
});

test('parseReverifyTag: rejects when commit sequence missing', () => {
  assert.equal(parseReverifyTag('reverify+demo123@example.com'), null);
});

test('parseReverifyTag: rejects non-numeric commit sequence', () => {
  assert.equal(parseReverifyTag('reverify+demo123-abc@example.com'), null);
  assert.equal(parseReverifyTag('reverify+demo123-3a@example.com'), null);
});

test('parseReverifyTag: rejects zero and out-of-range sequences', () => {
  assert.equal(parseReverifyTag('reverify+demo123-0@example.com'), null);
  assert.equal(parseReverifyTag('reverify+demo123-100000@example.com'), null);
});

test('parseReverifyTag: rejects traversal / dashes in eventId', () => {
  assert.equal(parseReverifyTag('reverify+..-3@example.com'), null);
  assert.equal(parseReverifyTag('reverify+a.b-3@example.com'), null);
  assert.equal(parseReverifyTag('reverify+abc-def-5@example.com'), null);
});

// --- parseInitiatorCommand (trimmed to stats/remind; close/bundle dropped) ---

test('parseInitiatorCommand: stats and remind on an alphanumeric id', () => {
  assert.deepEqual(parseInitiatorCommand('stats+abc123@example.com'),  { command: 'stats',  eventId: 'abc123' });
  assert.deepEqual(parseInitiatorCommand('remind+abc123@example.com'), { command: 'remind', eventId: 'abc123' });
});

test('parseInitiatorCommand: dropped policy commands (close/bundle) parse to null', () => {
  // These are gitdone policy, not kernel — the trim must exclude them.
  assert.equal(parseInitiatorCommand('close+abc123@example.com'), null);
  assert.equal(parseInitiatorCommand('bundle+abc123@example.com'), null);
});

test('parseInitiatorCommand: other non-command kinds return null', () => {
  assert.equal(parseInitiatorCommand('event+abc-step@example.com'), null);
  assert.equal(parseInitiatorCommand('verify+abc@example.com'), null);
  assert.equal(parseInitiatorCommand('reverify+abc-3@example.com'), null);
  assert.equal(parseInitiatorCommand('unknown+abc@example.com'), null);
});

test('parseInitiatorCommand: rejects non-alphanumeric event ids', () => {
  assert.equal(parseInitiatorCommand('stats+abc-def@example.com'), null);
  assert.equal(parseInitiatorCommand('remind+..@example.com'), null);
  assert.equal(parseInitiatorCommand('remind+@example.com'), null);
});

// --- boundary: policy-tag parsers are NOT lifted into the kernel ---

test('router does not export dropped policy parsers (attach/revoke)', () => {
  assert.equal(router.parseAttachTag, undefined);
  assert.equal(router.parseRevokeTag, undefined);
});
