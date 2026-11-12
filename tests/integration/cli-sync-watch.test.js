// `sync` and `watch` (SPEC B11.5, B11.9) with an injected fake sync and sleep: IMAP is never contacted. A real spawned
// watch (against a closed localhost port) proves the signal handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail } from '../helpers/proof.js';
import { makeWorld, account, BIN } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { hasForbidden } from '../helpers/forbidden.js';

const SECRET = 'Sup3r-Secret-Pw-91c';
const scripts = makeTmpDir('mp-cli-scripts-');
const passScript = path.join(scripts, 'pass.mjs');
fs.writeFileSync(passScript, `console.log(${JSON.stringify(SECRET)}); console.log('second line ignored');\n`);
const tokenScript = path.join(scripts, 'token.mjs');
fs.writeFileSync(tokenScript, `console.log('tok-' + Date.now() + '-' + Math.random());\n`);
const passCommand = `${process.execPath} ${passScript}`;

const result = (over = {}) => ({
  complete: true,
  folders: [{ folder: 'INBOX', direction: 'in', attempted: true, uidvalidity: '1', reset: null, last_uid: 3, seen: 3, recorded: 3, duplicate: 0, over_limit: 0, skipped: [], bytes: 10, complete: true, error: null, ...over }],
});
const failing = (code, message = 'boom') => Object.assign(new Error(message), { code });
const readState = (w, name) => JSON.parse(fs.readFileSync(path.join(w.stateDir, name, 'state.json'), 'utf8'));
const readLog = (w, name) => fs.readFileSync(path.join(w.stateDir, name, 'watch.log'), 'utf8');
const mk = (extra = {}) => makeWorld({ accounts: { acme: account(makeTmpDir('mp-cli-sw-trail-'), { passCommand, ...extra }) } });

test('sync: the account becomes the sync options; the secret comes from the command, appears nowhere, and each run re-runs it', async () => {
  const w = mk({ host: 'imap.acme.test', port: 1993, folders: ['INBOX', 'Archive'], sent: '[Gmail]/Sent Mail' });
  const seen = [];
  const deps = { sync: async (mp, opts) => { seen.push(opts); return result(); } };
  const r = await w.run(['sync', '--json'], { deps });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(seen[0], { host: 'imap.acme.test', port: 1993, user: 'me@owner.example', auth: { pass: SECRET }, folders: ['INBOX', 'Archive'], sent: '[Gmail]/Sent Mail' });
  const j = JSON.parse(r.stdout);
  assert.equal(j.complete, true);
  assert.equal(j.ots, null, 'OTS is off for this account');
  for (const out of [r.stdout, r.stderr, fs.readFileSync(path.join(w.stateDir, 'acme', 'state.json'), 'utf8')]) assert.ok(!out.includes(SECRET), 'the secret is never printed or stored');
  assert.deepEqual(readState(w, 'acme').lastSync.complete, true);
  assert.equal(readState(w, 'acme').lastSync.recorded, 3);
  assert.equal(fs.statSync(path.join(w.stateDir, 'acme')).mode & 0o777, 0o700);
  // flags override the account for this run
  await w.run(['sync', '--folders', 'A, B', '--sent', 'off'], { deps });
  assert.deepEqual([seen[1].folders, seen[1].sent], [['A', 'B'], false]);
  await w.run(['sync', '--sent', 'on'], { deps });
  assert.equal(seen[2].sent, true);
  assert.equal((await w.run(['sync', '--folders', ' , '], { deps })).code, 64);
});

test('sync: an access-token command is re-run every time (a fresh token); text output lists each folder', async () => {
  const w = makeWorld({ accounts: { acme: { user: 'u@x.test', trailDir: makeTmpDir('mp-cli-sw-trail-'), accessTokenCommand: `${process.execPath} ${tokenScript}` } } });
  const toks = [];
  const deps = { sync: async (mp, opts) => { toks.push(opts.auth.accessToken); return result(); } };
  const a = await w.run(['sync'], { deps });
  await w.run(['sync'], { deps });
  assert.equal(toks.length, 2);
  assert.notEqual(toks[0], toks[1]);
  assert.match(a.stdout, /^ok INBOX +in +seen 3  recorded 3  duplicate 0\ncomplete\n$/);
});

test('sync exit codes follow B4.1: partial 0, a folder error or a thrown error mapped, stdout still holds the result', async () => {
  const w = mk();
  const run = (fn) => w.run(['sync', '--json'], { deps: { sync: fn } });
  assert.equal((await run(async () => ({ ...result({ complete: false }), complete: false }))).code, 0, 'a capped run is still 0');
  for (const [code, want] of [['ERR_IMAP_TIMEOUT', 75], ['ERR_IMAP_THROTTLED', 75], ['ERR_IMAP_UIDVALIDITY', 75], ['ERR_IMAP_CONNECT', 75], ['ERR_IMAP_NO_FOLDER', 1], ['ERR_IMAP_AUTH', 77]]) {
    const r = await run(async () => result({ complete: false, error: { code, message: 'm' } }));
    assert.equal(r.code, want, code);
    assert.equal(JSON.parse(r.stdout).folders[0].error.code, code, 'the output is still printed');
    assert.match(r.stderr, new RegExp(`INBOX: ${code}: m`));
  }
  for (const [code, want] of [['ERR_SYNC_LOCKED', 75], ['ERR_TRAIL_LOCKED', 75], ['ERR_IMAP_AUTH', 77], ['ERR_IMAP_CONNECT', 75], ['EX_SECRET_COMMAND', 75], ['ERR_OTHER', 1]]) {
    const r = await run(async () => { throw failing(code); });
    assert.equal(r.code, want, code);
    assert.equal(r.stdout, '', 'a thrown error prints nothing on stdout');
  }
  assert.equal(readState(w, 'acme').lastSync.error, 'ERR_OTHER');
});

test('sync with a secret command that fails is 75 and never echoes the command output', async () => {
  const w = mk({ passCommand: '/nonexistent/cmd --token hunter2' });
  const r = await w.run(['sync'], { deps: { sync: async () => result() } });
  assert.equal(r.code, 75);
  assert.ok(!r.stderr.includes('hunter2'));
  assert.match(r.stderr, /pass command failed/);
});

test('sync with OTS on: the run ends with the stamp job, its result is `ots` (a superset of 3.3.0), a second run is not due; `stamp` runs it now; status and show report the seal', async () => {
  const dir = makeTmpDir('mp-cli-ots-trail-');
  const marker = path.join(makeTmpDir('mp-cli-ots-m-'), 'm');
  const bin = path.join(scripts, 'ots');
  fs.writeFileSync(bin, `#!/bin/sh\ncase "$1" in stamp) cp "$2" "$2.ots";; upgrade) if [ -f "${marker}" ]; then grep -q anchored "$2" || { cp "$2" "$2.bak"; echo anchored >> "$2"; }; exit 0; else exit 1; fi;; info) echo "Bitcoin block 777";; esac\n`, { mode: 0o755 });
  const m = await signedMail({});
  const rec = await new Mailproof({ trailDir: dir, resolver: m.resolver, worker: { size: 0 }, otsBin: bin }).record(m.raw, { direction: 'in' });
  assert.equal(rec.ots, 'queued');
  const w = makeWorld({ accounts: { acme: account(dir, { passCommand, ots: bin }) } });
  const deps = { sync: async (mp) => ({ ...result(), stamp: await mp._autoStamp() }) };
  const st0 = JSON.parse((await w.run(['status', '--json'])).stdout).acme;
  assert.deepEqual([st0.pendingStamps, st0.seal.enabled, st0.seal.manifests, st0.seal.last], [0, true, 0, null]);
  assert.match((await w.run(['status'])).stdout, /seal +batch every 6h; never run/);
  assert.match((await w.run(['show', rec.id])).stdout, /^seal +unsealed$/m);
  const first = JSON.parse((await w.run(['sync', '--json'], { deps })).stdout).ots;
  assert.deepEqual([first.ran, first.manifests.length, first.manifests[0].records, first.stamped, first.upgraded, first.pending, first.unstamped, first.unsealed], [true, 1, 1, 1, 0, 1, 0, 0]);
  const again = JSON.parse((await w.run(['sync', '--json'], { deps })).stdout).ots;
  assert.deepEqual([again.ran, again.skipped, again.upgraded, again.pending], [false, 'not due', 0, 1], 'upgraded and pending keep their meaning');
  assert.match((await w.run(['sync'], { deps })).stdout, /^seal: next due \d\d:\d\dZ \(in [56] h\); 1 waiting for its Bitcoin anchor$/m, 'plain words: no `ots:`, no `skipped`, no counts of upgrades');
  const sh = (await w.run(['show', rec.id])).stdout;
  assert.match(sh, /^seal +manifest 1, stamped by manifest 1 \(pending\)$/m);
  const st1 = JSON.parse((await w.run(['status', '--json'])).stdout).acme;
  assert.deepEqual([st1.seal.manifests, st1.seal.unstamped, st1.seal.pending, st1.seal.chain, st1.pendingStamps], [1, 0, 1, 'ok', 1]);
  assert.match((await w.run(['status'])).stdout, /seal +batch every 6h; last \d{4}-.*next due .*; 1 manifests \(0 without a proof\); 1 proofs not yet anchored/);
  // `stamp` runs the job now, whatever the cadence: it upgrades once the calendars have it
  fs.writeFileSync(marker, '');
  const s1 = await w.run(['stamp', '--json']);
  assert.equal(s1.code, 0, s1.stderr);
  const sj = JSON.parse(s1.stdout);
  assert.deepEqual([sj.ran, sj.manifests, sj.upgraded, sj.pending, sj.error], [true, [], 1, 0, undefined]);
  const s2 = await w.run(['stamp']);
  assert.equal(s2.code, 0);
  assert.match(s2.stdout, /nothing new to seal/);
  assert.match((await w.run(['show', rec.id])).stdout, /^seal +manifest 1, stamped by manifest 1 \(anchored, block 777\)$/m);
  assert.equal(JSON.parse((await w.run(['status', '--json'])).stdout).acme.pendingStamps, 0);
  // a held stamp lock is 75
  fs.writeFileSync(path.join(dir, '.default.stamp.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
  const locked = await w.run(['stamp']);
  fs.rmSync(path.join(dir, '.default.stamp.lock'));
  assert.equal(locked.code, 75);
  // a missing binary: one plain message, the sync still succeeds (exit 0), `stamp` exits 1, status shows it
  const m2 = await signedMail({ body: 'second\r\n' });
  await new Mailproof({ trailDir: dir, resolver: m2.resolver, worker: { size: 0 }, otsBin: null }).record(m2.raw, { direction: 'in' });
  const w2 = makeWorld({ accounts: { acme: account(dir, { passCommand, ots: '/nonexistent/ots' }) } });
  fs.rmSync(path.join(dir, '.default.stamp.json'), { force: true });
  const bad = await w2.run(['sync', '--json'], { deps });
  assert.equal(bad.code, 0);
  const MSG = 'ots not installed: records are not sealed; install opentimestamps-client or set ots: false';
  assert.equal(JSON.parse(bad.stdout).ots.error, MSG);
  assert.match((await w2.run(['sync'], { deps })).stdout, /^seal: next due /m, 'one spawn per cadence, not per sync');
  const sb = await w2.run(['stamp']);
  assert.equal(sb.code, 1);
  assert.ok(sb.stderr.includes(MSG), sb.stderr);
  assert.ok(sb.stdout.includes(MSG));
  assert.match((await w2.run(['status'])).stdout, /ots not installed/);
  // off: nothing is done and the CLI says so
  const w3 = makeWorld({ accounts: { acme: account(dir, { passCommand, ots: false }) } });
  const off = await w3.run(['stamp']);
  assert.deepEqual([off.code, off.stdout.trim()], [0, 'ots is off for this account']);
  assert.equal(JSON.parse((await w3.run(['sync', '--json'], { deps })).stdout).ots, null);
  assert.match((await w3.run(['status'])).stdout, /seal +off/);
});

/** A watch run: ticks until `stopAfter` sleeps, then aborts like a SIGTERM would. */
async function watch(w, fns, { argv = [], stopAfter = fns.length, json = false } = {}) {
  const ac = new AbortController();
  const sleeps = [];
  let i = 0;
  const deps = {
    minIntervalMs: 1, now: () => new Date('2026-11-10T12:00:00Z'),
    sync: async (mp, opts) => fns[Math.min(i++, fns.length - 1)](),
    sleep: async (ms) => { sleeps.push(ms); if (sleeps.length >= stopAfter) ac.abort(); },
  };
  const r = await w.run(['watch', '--interval', '30s', ...(json ? ['--json'] : []), ...argv], { deps, signal: ac.signal });
  return { ...r, sleeps, ticks: i };
}

test('watch: one line per tick, appended to watch.log, the interval between ticks, state running then stopped, exit 0 on a signal', async () => {
  const w = mk();
  const r = await watch(w, [async () => result(), async () => result({ recorded: 0, seen: 0 }), async () => result()], {});
  assert.equal(r.code, 0);
  assert.deepEqual(r.sleeps, [30_000, 30_000, 30_000]);
  assert.equal(r.ticks, 3);
  const tick = (n, seen) => ['2026-11-10T12:00:00Z ok recorded ' + n, `  ok INBOX                    in    seen ${seen}  recorded ${n}  duplicate 0`];
  assert.deepEqual(r.stdout.trim().split('\n'), [...tick(3, 3), ...tick(0, 0), ...tick(3, 3)], 'each tick: its line, then the per-folder counts as sync prints them (SPEC B11.9)');
  assert.equal(readLog(w, 'acme'), r.stdout.split('\n').filter((l) => !l.startsWith('  ')).join('\n'), 'the log keeps one line per tick');
  const st = readState(w, 'acme');
  assert.equal(st.lastWatch.state, 'stopped');
  assert.equal(st.lastWatch.pid, process.pid);
  assert.equal(st.lastSync.recorded, 3);
});

test('watch --json: one JSON line per tick', async () => {
  const w = mk();
  const r = await watch(w, [async () => result(), async () => { throw failing('ERR_SYNC_LOCKED'); }], { json: true });
  const ticks = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(ticks.map((t) => t.status), ['ok', 'locked']);
  assert.equal(ticks[0].result.folders[0].recorded, 3);
  assert.equal(ticks[0].nextInMs, 30_000);
  assert.equal(ticks[1].error.code, 'ERR_SYNC_LOCKED');
});

test('watch: a held lock is "skipped (locked)" and the next tick comes at the normal interval (no backoff)', async () => {
  const w = mk();
  const r = await watch(w, [async () => { throw failing('ERR_SYNC_LOCKED'); }, async () => { throw failing('ERR_TRAIL_LOCKED'); }, async () => result()]);
  assert.deepEqual(r.sleeps, [30_000, 30_000, 30_000]);
  assert.match(r.stdout, /skipped \(locked\)\n.*skipped \(locked\)\n.* ok recorded 3\n {2}ok INBOX.*\n$/);
  assert.equal(r.code, 0);
});

test('watch: transient errors back off (the interval doubled, capped at 1 h), a success resets it, the loop goes on', async () => {
  const w = mk();
  const fail = async () => { throw failing('ERR_IMAP_CONNECT', 'down'); };
  const fns = [fail, fail, fail, async () => result(), fail, async () => ({ ...result(), folders: [{ ...result().folders[0], complete: false, error: { code: 'ERR_IMAP_THROTTLED', message: 'slow down' } }], complete: false })];
  const r = await watch(w, fns, { stopAfter: 6 });
  assert.deepEqual(r.sleeps, [60_000, 120_000, 240_000, 30_000, 60_000, 120_000]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /error ERR_IMAP_CONNECT: down; next in 60s/);
  assert.match(r.stdout, /error ERR_IMAP_THROTTLED: slow down; next in 120s/, 'a folder error of the 75 class counts too');
  // the cap: many failures never wait longer than an hour
  const w2 = mk();
  const many = await watch(w2, [fail], { stopAfter: 12, argv: [] });
  assert.equal(Math.max(...many.sleeps), 3_600_000);
  assert.equal(many.sleeps[11], 3_600_000);
});

test('watch: a refused login stops it with 77 (no retry, no sleep); any other error stops it with 1; both leave state stopped', async () => {
  const w = mk();
  const a = await watch(w, [async () => { throw failing('ERR_IMAP_AUTH', 'refused'); }], { stopAfter: 99 });
  assert.equal(a.code, 77);
  assert.deepEqual(a.sleeps, []);
  assert.match(a.stdout, /login refused \(ERR_IMAP_AUTH\); stopping/);
  assert.equal(readState(w, 'acme').lastWatch.state, 'stopped');
  const b = await watch(mk(), [async () => { throw failing('ERR_WEIRD', 'odd'); }], { stopAfter: 99 });
  assert.equal(b.code, 1);
  assert.deepEqual(b.sleeps, []);
  const c = await watch(mk(), [async () => result({ complete: false, error: { code: 'ERR_IMAP_NO_FOLDER', message: 'no such folder' } })], { stopAfter: 99 });
  assert.equal(c.code, 1, 'a folder error outside the 75 class stops it');
});

test('watch: a signal during a sync lets the sync finish, then stops with 0 and state stopped', async () => {
  const w = mk();
  const ac = new AbortController();
  let finished = false;
  const deps = {
    sync: async () => { ac.abort(); await new Promise((r) => setTimeout(r, 20)); finished = true; return result(); },
    sleep: async () => { throw new Error('must not sleep after a signal'); },
  };
  const r = await w.run(['watch'], { deps, signal: ac.signal });
  assert.equal(r.code, 0);
  assert.equal(finished, true);
  assert.match(r.stdout, /ok recorded 3/);
  assert.equal(readState(w, 'acme').lastWatch.state, 'stopped');
});

test('watch: the interval has a 30 s floor; a bad value is 64; the log is cut to its last MiB at start', async () => {
  const w = mk();
  assert.equal((await w.run(['watch', '--interval', '10s'], { deps: {} })).code, 64);
  assert.equal((await w.run(['watch', '--interval', 'often'], { deps: {} })).code, 64);
  const log = path.join(w.stateDir, 'acme', 'watch.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `${'x'.repeat(99)}\n`.repeat(12000));   // 1.2 MB
  const r = await watch(w, [async () => result()]);
  assert.equal(r.code, 0);
  const text = fs.readFileSync(log, 'utf8');
  assert.ok(text.length < 1024 * 1024 + 200, `${text.length}`);
  assert.ok(text.startsWith('x'.repeat(99)), 'cut at a line boundary');
  assert.match(text, / ok recorded 3\n$/);
});

test('status shows a watch as running only while its pid is alive', async () => {
  const w = mk();
  fs.mkdirSync(path.join(w.stateDir, 'acme'), { recursive: true });
  const put = (pid, state) => fs.writeFileSync(path.join(w.stateDir, 'acme', 'state.json'), JSON.stringify({ v: 1, lastWatch: { at: 'x', pid, state } }));
  put(process.pid, 'running');
  assert.deepEqual(JSON.parse((await w.run(['status', '--json'])).stdout).acme.watch, { running: true, pid: process.pid });
  put(2 ** 22 + 12345, 'running');
  assert.equal(JSON.parse((await w.run(['status', '--json'])).stdout).acme.watch.running, false, 'a dead pid is not running');
  put(process.pid, 'stopped');
  assert.equal(JSON.parse((await w.run(['status', '--json'])).stdout).acme.watch.running, false);
});

test('a real watch process stops on SIGTERM with exit 0 and state "stopped"; a second signal is not needed', async () => {
  // a closed localhost port: the connection is refused at once (ERR_IMAP_CONNECT), so the loop is in its backoff sleep
  const w = makeWorld({ accounts: { acme: account(makeTmpDir('mp-cli-sw-trail-'), { passCommand, host: '127.0.0.1', port: 1 }) } });
  const child = spawn(process.execPath, [BIN, 'watch', '--interval', '30s'], { env: w.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const t0 = Date.now();
  while (!/ERR_IMAP_CONNECT/.test(out) && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /error ERR_IMAP_CONNECT/, 'the first tick ran and failed');
  assert.equal(readState(w, 'acme').lastWatch.state, 'running');
  child.kill('SIGTERM');
  const end = await closed;
  assert.deepEqual(end, { code: 0, signal: null });
  assert.equal(readState(w, 'acme').lastWatch.state, 'stopped');
});

test('watch: a hostile server error message is escaped on stdout, stderr and in watch.log (F28)', async () => {
  const w = mk();
  const evil = 'bad\u001b[1A\u001b]0;pwned\u0007\u009b2J\u202e';
  const r = await watch(w, [async () => { throw failing('ERR_WEIRD', evil); }], { stopAfter: 99 });
  assert.equal(r.code, 1);
  const log = readLog(w, 'acme');
  for (const [what, text] of [['stdout', r.stdout], ['stderr', r.stderr], ['watch.log', log]]) assert.ok(!hasForbidden(text), `${what}: ${JSON.stringify(text)}`);
  assert.ok(log.includes('bad\\x1b[1A\\x1b]0;pwned\\x07\\x9b2J\\u202e'), log);
});

import { stampText } from '../../src/cli/sync-op.js';
import { makeStyle } from '../../src/cli/style.js';

test('stampText: nothing to do is one line; any count or manifest keeps the full report', () => {
  const st = makeStyle();
  const base = { enabled: true, ran: true, manifests: [], stamped: null, upgraded: 0, pending: 0, unstamped: 0, unsealed: 0 };
  assert.equal(stampText(base, st), 'nothing new to seal');
  for (const k of ['upgraded', 'pending', 'unstamped', 'unsealed']) assert.ok(stampText({ ...base, [k]: 1 }, st).split('\n').length >= 2, k);
  assert.match(stampText({ ...base, skipped: 'no ots binary' }, st), /skipped \(no ots binary\)/, 'a skip reason is never hidden');
  const sealed = stampText({ ...base, manifests: [{ seq: 1, records: 3, replies: 0 }], stamped: 1, pending: 1 }, st);
  assert.equal(sealed, st.sym.ok + ' sealed 3 new records\nthe Bitcoin anchor is pending (usually a few hours); it completes on the next sync or seal');
  assert.match(stampText({ ...base, manifests: [{ seq: 1, records: 1, replies: 0 }], stamped: 1 }, st), /sealed 1 new record$/m, 'plain plural');
});
