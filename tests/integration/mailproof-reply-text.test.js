// Mailproof#replyText against a real git trail (SPEC B6): the proof flags, the reply-text record, the failure codes,
// worker vs in-process, and that the trail index never sees replies/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/proof/mailproof.js';
import { WorkerPool, workerConfig } from '../../src/proof/pool.js';
import { signedMail } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { FIXTURES, QUOTED } from '../helpers/reply-fixtures.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const T0 = new Date('2026-11-01T10:00:00Z');
const tmp = () => makeTmpDir('mp-reply-');
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const clock = (iso = '2026-11-01T10:00:00Z') => () => new Date(iso);
const mk = (dir, m, extra = {}) => new Mailproof({ trailDir: dir, resolver: m?.resolver, now: clock(), ...extra });
const SPLIT = Buffer.from('\r\n\r\n');
const withBody = (raw, fn) => { const i = raw.indexOf(SPLIT) + 4; return Buffer.concat([raw.subarray(0, i), Buffer.from(fn(raw.subarray(i).toString('binary')), 'binary')]); };
const hashOf = (s) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const commits = (root) => gitOut(root, 'rev-list', '--count', 'HEAD');

const TOKEN = 'ZEBRA-7731';
const BODY = [`${TOKEN} approved.`, '', 'On Mon, Bob Example wrote:', `> ${QUOTED}`, '', '-- ', 'Alice Wonder', ''].join('\r\n');
const NEW_TEXT = `${TOKEN} approved.`;

async function signedReply(extra = {}) { return signedMail({ signTime: T0, subject: 'Re: Quarterly sign-off', body: BODY, ...extra }); }

test('signed and matched: the new text, proven, trailing flagged; one commit with a record that holds no text', async () => {
  const dir = tmp();
  const m = await signedReply();
  const mp = mk(dir, m);
  const rec = await mp.record(m.raw, { direction: 'in', source: 'test' });
  const root = path.join(dir, 'default');
  const r = await mp.replyText(m.raw);
  assert.deepEqual({ ...r, commit: undefined }, {
    id: rec.id, text: NEW_TEXT, text_sha256: hashOf(NEW_TEXT), text_bytes: NEW_TEXT.length,
    quote: 'found', trailing: true, source: 'text/plain', boundary: 'attribution', stripper: 'mailproof-quote/1',
    body_status: 'matched', proven: true, commit: undefined, duplicate: false,
  });
  assert.equal(r.commit, gitOut(root, 'rev-parse', 'HEAD'));
  assert.equal(commits(root), '3', 'trail created, the record, the reply text');
  assert.equal(gitOut(root, 'log', '-1', '--format=%s'), `reply-text ${rec.id.slice(0, 12)} mailproof-quote/1 found`);
  assert.equal(gitOut(root, 'show', '--name-only', '--format=', 'HEAD'), `replies/${rec.id}.mailproof-quote-1.json`);
  assert.equal(gitOut(root, 'status', '--porcelain'), '');

  const file = fs.readFileSync(path.join(root, 'replies', `${rec.id}.mailproof-quote-1.json`), 'utf8');
  assert.deepEqual(JSON.parse(file), {
    v: 2, kind: 'reply-text', record_id: rec.id, text_sha256: hashOf(NEW_TEXT), text_bytes: NEW_TEXT.length,
    stripper: 'mailproof-quote/1', quote: 'found', trailing: true, source: 'text/plain', boundary: 'attribution',
    body_status: 'matched', extracted_at: '2026-11-01T10:00:00.000Z',
  });
  assert.deepEqual(Object.keys(JSON.parse(file)), ['v', 'kind', 'record_id', 'text_sha256', 'text_bytes', 'stripper', 'quote', 'trailing', 'source', 'boundary', 'body_status', 'extracted_at']);
  assert.ok(file.endsWith('}\n'));
  // nothing of the mail's words anywhere in the trail history: not in the file, not in a commit message, not in any diff
  const everything = gitOut(root, 'log', '-p', '--format=%B', '--all') + file;
  for (const w of [TOKEN, 'approved', 'Approve payment', 'Bob Example', 'Alice Wonder', 'Quarterly']) assert.ok(!everything.includes(w), `"${w}" must not be in the trail`);
  // proof paths are untouched by the new file
  assert.equal((await mp.verify(rec.id)).ok, true);
  assert.deepEqual(await mp.get(rec.id), rec.record ? JSON.parse(JSON.stringify(rec.record)) : null);
});

test('tampered body (mismatch), partial (l= prefix) and unsigned copies: text returned, proven false', async () => {
  const dir = tmp();
  const m = await signedReply();
  const mp = mk(dir, m);
  const tampered = withBody(m.raw, (b) => b.replace(TOKEN, 'ZEBRA-0000'));
  await mp.record(tampered, { direction: 'in' });
  const t = await mp.replyText(tampered);
  assert.equal(t.body_status, 'mismatch');
  assert.equal(t.proven, false);
  assert.equal(t.text, 'ZEBRA-0000 approved.', 'the text is still returned, never silently proven');

  const part = await signedMail({ signTime: T0, body: 'Signed prefix.\r\n', bodyLength: 15, signers: [{ domain: m.domain, selector: 'sel1', key: m.signers[0].key }] });
  const partial = withBody(part.raw, (b) => b + 'unsigned tail\r\n');
  await mp.record(partial, { direction: 'in' });
  const p = await mp.replyText(partial);
  assert.equal(p.body_status, 'partial');
  assert.equal(p.proven, false, 'partial is unproven in v1 (fail closed)');
  assert.equal(p.text, 'Signed prefix.\nunsigned tail');

  const unsigned = Buffer.from('From: me@own.example\r\nSubject: Re: x\r\nContent-Type: text/plain\r\n\r\nSent copy.\r\n');
  await mp.record(unsigned, { direction: 'out' });
  const u = await mp.replyText(unsigned);
  assert.equal(u.body_status, 'not-checked');
  assert.equal(u.proven, false);
});

test('ERR_NOT_RECORDED: nothing recorded, another message, one byte different; nothing is written', async () => {
  const dir = tmp();
  const m = await signedReply();
  const mp = mk(dir, m);
  await assert.rejects(() => mp.replyText(m.raw), { code: 'ERR_NOT_RECORDED' });
  assert.ok(!fs.existsSync(path.join(dir, 'default')), 'not even the trail is created');
  await mp.record(m.raw, { direction: 'in' });
  const root = path.join(dir, 'default');
  const before = commits(root);
  await assert.rejects(() => mp.replyText(Buffer.concat([m.raw, Buffer.from('x')])), { code: 'ERR_NOT_RECORDED' });
  await assert.rejects(() => mp.replyText('Subject: other\r\n\r\nbody'), { code: 'ERR_NOT_RECORDED' });
  assert.equal(commits(root), before);
  assert.ok(!fs.existsSync(path.join(root, 'replies')));
  await assert.rejects(() => mp.replyText(Buffer.alloc(0)), /empty message/);
});

test('over limit: rejects ERR_OVER_LIMIT with the limit name, writes nothing (gate, and the CPU backstop)', async () => {
  const dir = tmp();
  const mp = mk(dir, null, { worker: { size: 0 } });
  const big = Buffer.from('Content-Type: text/plain\r\n\r\n' + 'x\r\n'.repeat(500001));
  const r = await mp.record(big, { direction: 'in' });
  assert.equal((await mp.get(r.id)).verdicts.live.reason, 'over limit: body_lines');
  const root = path.join(dir, 'default');
  const before = commits(root);
  for (const worker of [{ size: 0 }, { size: 1 }]) {
    const e = await mk(dir, null, { worker }).replyText(big).catch((x) => x);
    assert.equal(e.code, 'ERR_OVER_LIMIT', JSON.stringify(worker));
    assert.equal(e.limit, 'body_lines');
  }
  assert.equal(commits(root), before);
  assert.ok(!fs.existsSync(path.join(root, 'replies')));

  // the deadline backstop covers the stripper: a reply that costs ~1 s of CPU against a 50 ms budget is stopped
  const heavy = Buffer.from('Content-Type: text/plain\r\n\r\n' + 'On x\r\n'.repeat(300000));
  await mp.record(heavy, { direction: 'in' });
  const slim = mk(dir, null, { worker: { size: 1, cpuMs: 50 } });
  try {
    const e = await slim.replyText(heavy).catch((x) => x);
    assert.equal(e.code, 'ERR_OVER_LIMIT');
    assert.equal(e.limit, 'time');
  } finally { await slim.close(); }
  assert.ok(!fs.existsSync(path.join(root, 'replies')));
  const pool = new WorkerPool(workerConfig({ cpuMs: 50 }));
  try {
    assert.deepEqual(await pool.runReplyText(heavy), { limit: 'time' });
    const ok = await pool.runReplyText(Buffer.from('Content-Type: text/plain\r\n\r\nhi'));
    assert.equal(ok.out.stripped.text, 'hi', 'the pool is usable after a kill');
  } finally { await pool.close(); }
});

test('duplicate: the same message again returns the text, writes nothing; a later clock changes nothing', async () => {
  const dir = tmp();
  const m = await signedReply();
  const mp = mk(dir, m);
  await mp.record(m.raw, { direction: 'in' });
  const first = await mp.replyText(m.raw);
  const root = path.join(dir, 'default');
  const n = commits(root);
  const file = path.join(root, 'replies', `${first.id}.mailproof-quote-1.json`);
  const bytes = fs.readFileSync(file);
  const later = mk(dir, m, { now: clock('2027-01-01T00:00:00Z') });
  const again = await later.replyText(m.raw);
  assert.equal(again.duplicate, true);
  assert.equal(again.text, first.text);
  assert.equal(again.text_sha256, first.text_sha256);
  assert.equal(again.commit, gitOut(root, 'rev-parse', 'HEAD'));
  assert.equal(commits(root), n);
  assert.deepEqual(fs.readFileSync(file), bytes, 'the committed file is not rewritten');
  await later.close();
});

test('concurrent calls for one message: one commit, one duplicate', async () => {
  const dir = tmp();
  const m = await signedReply();
  const mp = mk(dir, m);
  await mp.record(m.raw, { direction: 'in' });
  const rs = await Promise.all([mp.replyText(m.raw), mp.replyText(m.raw), mp.replyText(m.raw)]);
  assert.equal(rs.filter((r) => !r.duplicate).length, 1);
  assert.equal(commits(path.join(dir, 'default')), '3');
});

test('html-only: nothing extracted, flagged, unproven; the record says so', async () => {
  const dir = tmp();
  const mp = mk(dir, null);
  const html = Buffer.from(`From: a@a.example\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>${QUOTED}</p>\r\n`);
  await mp.record(html, { direction: 'in' });
  const r = await mp.replyText(html);
  assert.deepEqual({ ...r, id: undefined, commit: undefined }, {
    id: undefined, text: '', text_sha256: hashOf(''), text_bytes: 0, quote: 'not-found', trailing: false, source: 'html-only', boundary: null,
    stripper: 'mailproof-quote/1', body_status: 'not-checked', proven: false, commit: undefined, duplicate: false,
  });
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'default', 'replies', `${r.id}.mailproof-quote-1.json`), 'utf8'));
  assert.equal(file.source, 'html-only');
  assert.equal(file.text_bytes, 0);
});

test('the worker and in-process agree on every fixture: result, record file and commit message', async () => {
  const dirs = { worker: tmp(), inproc: tmp() };
  const mps = { worker: mk(dirs.worker, null, { worker: { size: 1 } }), inproc: mk(dirs.inproc, null, { worker: { size: 0 } }) };
  try {
    for (const f of FIXTURES) {
      const out = {};
      for (const k of ['worker', 'inproc']) {
        await mps[k].record(f.raw, { direction: 'in' });
        const r = await mps[k].replyText(f.raw);
        out[k] = { ...r, commit: undefined };
        out[k].file = fs.readFileSync(path.join(dirs[k], 'default', 'replies', `${r.id}.mailproof-quote-1.json`), 'utf8');
        out[k].msg = gitOut(path.join(dirs[k], 'default'), 'log', '-1', '--format=%s');
      }
      assert.deepEqual(out.worker, out.inproc, f.name);
      assert.equal(out.worker.text, f.expect.text, f.name);
      assert.equal(out.worker.quote, f.expect.quote, f.name);
      assert.equal(out.worker.trailing, f.expect.trailing, f.name);
    }
  } finally { await mps.worker.close(); await mps.inproc.close(); }
});

test('the trail index ignores replies/: rows unchanged, catch-up and rebuild both work', async () => {
  const dir = tmp();
  const m1 = await signedReply();
  const m2 = await signedMail({ signTime: T0, body: 'second\r\n', signers: [{ domain: m1.domain, selector: 'sel1', key: m1.signers[0].key }] });
  const mp = mk(dir, m1);
  const a = await mp.record(m1.raw, { direction: 'in' });
  const b = await mp.record(m2.raw, { direction: 'in' });
  const root = path.join(dir, 'default');
  const rows = await mp.list();                          // opens the index
  assert.equal(rows.length, 2);
  const copiesBefore = await mp.copies(a.id);
  await mp.replyText(m1.raw);                            // HEAD moves, records/ does not
  const head = gitOut(root, 'rev-parse', 'HEAD');
  assert.deepEqual(await mp.list(), rows);
  assert.deepEqual(await mp.copies(a.id), copiesBefore);
  const index = path.join(dir, '.default.index.sqlite');
  const meta = () => { const d = new Database(index, { readonly: true }); try { return d.prepare("SELECT v FROM meta WHERE k = 'head'").get().v; } finally { d.close(); } };
  assert.equal(meta(), head, 'caught up to the reply-text commit');
  const ids = () => { const d = new Database(index, { readonly: true }); try { return d.prepare('SELECT id FROM rec ORDER BY id').all().map((x) => x.id); } finally { d.close(); } };
  assert.deepEqual(ids(), [a.id, b.id].sort());
  // a record after a reply commit (the index is one commit behind the insert path) and a full rebuild
  const m3 = await signedMail({ signTime: T0, body: 'third\r\n', signers: [{ domain: m1.domain, selector: 'sel1', key: m1.signers[0].key }] });
  const c = await mp.record(m3.raw, { direction: 'in' });
  assert.equal((await mp.list()).length, 3);
  await mp.close();
  fs.rmSync(index);
  const fresh = mk(dir, m1);
  assert.equal((await fresh.list()).length, 3, 'rebuild from records/ only');
  assert.deepEqual(ids(), [a.id, b.id, c.id].sort());
  await fresh.close();
});

test('a crashed writer\'s leftover reply file is cleared; a failing commit rolls back; other files in replies/ are left alone', async () => {
  const dir = tmp();
  const m = await signedReply();
  const mp = mk(dir, m);
  const rec = await mp.record(m.raw, { direction: 'in' });
  const root = path.join(dir, 'default');
  fs.mkdirSync(path.join(root, 'replies'), { recursive: true });
  const leftover = path.join(root, 'replies', `${rec.id}.mailproof-quote-1.json`);
  fs.writeFileSync(leftover, '{"half":"written"}');
  fs.writeFileSync(path.join(root, 'replies', 'notes.txt'), 'mine');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(() => mp.replyText(m.raw), /git commit failed/);
  assert.ok(!fs.existsSync(leftover), 'rolled back: no half-written reply file');
  assert.equal(fs.readFileSync(path.join(root, 'replies', 'notes.txt'), 'utf8'), 'mine');
  assert.equal(commits(root), '2');
  fs.rmSync(hook);
  const r = await mp.replyText(m.raw);
  assert.equal(r.duplicate, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(leftover, 'utf8')).record_id, rec.id);
  assert.equal(fs.readFileSync(path.join(root, 'replies', 'notes.txt'), 'utf8'), 'mine');
});

test('raw as a string works like the same bytes as a Buffer', async () => {
  const dir = tmp();
  const mp = mk(dir, null, { worker: { size: 0 } });
  const raw = 'From: a@a.example\r\nContent-Type: text/plain\r\n\r\nPlain.\r\n';
  await mp.record(raw, { direction: 'in' });
  const r = await mp.replyText(raw);
  assert.equal(r.text, 'Plain.');
  assert.equal((await mp.replyText(Buffer.from(raw))).duplicate, true);
});
