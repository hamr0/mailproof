
// Integration tests for sendmail(): they spawn a REAL child process (the
// injected `binary`) and touch the filesystem via fake-sendmail scripts in
// tmp. No mocks — we drive the actual child_process path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendmail } from '../../src/outbound.js';

// Write an executable fake-sendmail script into a fresh tmp dir; returns
// { dir, script, ...extra } and registers cleanup on the test context.
function fakeSendmail(t, bodyLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailproof-outbound-'));
  const script = path.join(dir, 'fake-sendmail.sh');
  fs.writeFileSync(script, `#!/bin/sh\n${bodyLines.join('\n')}\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, script };
}

test('sendmail: ok=true when the binary exits 0', async () => {
  const r = await sendmail({ from: 'x@y', rawMessage: 'whatever', binary: '/bin/true' });
  assert.equal(r.ok, true);
});

test('sendmail: ok=false with the exit code when the binary exits non-zero', async () => {
  const r = await sendmail({ from: 'x@y', rawMessage: 'whatever', binary: '/bin/false' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
});

test('sendmail: ok=false with a reason when the binary is missing', async () => {
  const r = await sendmail({ from: 'x@y', rawMessage: 'whatever', binary: '/nonexistent/sendmail' });
  assert.equal(r.ok, false);
  assert.ok(r.reason || r.code);
});

test('sendmail: ok=false when no binary is configured (injected config required)', async () => {
  const r = await sendmail({ from: 'x@y', rawMessage: 'hi' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sendmail binary not configured');
});

test('sendmail: empty message fast-fails before spawning', async () => {
  const r = await sendmail({ from: 'x@y', rawMessage: '', binary: '/bin/true' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty message');
});

test('sendmail: positional recipients use the `--` separator and drop -t', async (t) => {
  // $0 is the script's own path; "$@" is the argv sendmail() built.
  const { dir, script } = fakeSendmail(t, ['echo "$@" > "$0.args"', 'cat > /dev/null', 'exit 0']);
  const r = await sendmail({ from: 'env@x', rawMessage: 'hello', binary: script, to: ['a@x', 'b@x'] });
  assert.equal(r.ok, true);
  const args = fs.readFileSync(path.join(dir, 'fake-sendmail.sh.args'), 'utf8').trim().split(/\s+/);
  assert.ok(!args.includes('-t'), 'positional mode must not pass -t');
  assert.ok(args.includes('--'), 'must use -- to terminate options');
  assert.ok(args.includes('a@x') && args.includes('b@x'));
});

test('sendmail: default (no to[]) uses -t and no `--`', async (t) => {
  const { dir, script } = fakeSendmail(t, ['echo "$@" > "$0.args"', 'cat > /dev/null', 'exit 0']);
  const r = await sendmail({ from: 'env@x', rawMessage: 'hi', binary: script });
  assert.equal(r.ok, true);
  const args = fs.readFileSync(path.join(dir, 'fake-sendmail.sh.args'), 'utf8').trim().split(/\s+/);
  assert.ok(args.includes('-t'));
  assert.ok(!args.includes('--'));
});

test('sendmail: pipes rawMessage verbatim to the binary stdin', async (t) => {
  const { dir, script } = fakeSendmail(t, ['cat > "$0.stdin"']);
  const r = await sendmail({ from: 'x@y', rawMessage: 'STDIN-MARKER-abc123', binary: script });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'fake-sendmail.sh.stdin'), 'utf8'), 'STDIN-MARKER-abc123');
});
