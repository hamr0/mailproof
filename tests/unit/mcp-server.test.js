// The MCP server in process (SPEC B12.9, B12.11): accounts, lazy open and close, shared worker, error mapping, sync, concurrency,
// shutdown, the path TOCTOU, the audit log. IMAP is never contacted (deps.sync); no real mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Mailproof } from '../../src/index.js';
import { mailproofOptions } from '../../src/cli/config.js';
import { serveMcp, summarize } from '../../src/mcp/server.js';
import { readLines, serve, createProtocol } from '../../src/mcp/protocol.js';
import { validate } from '../../src/mcp/schema.js';
import { toErrorObject, ToolError } from '../../src/mcp/errors.js';
import { UsageError } from '../../src/cli/errors.js';
import { SYNC_MAX_MESSAGES_DEFAULT } from '../../src/mcp/handlers.js';
import { loadConfig } from '../../src/cli/config.js';
import { makeWorld, account } from '../helpers/cli.js';
import { inProcess } from '../helpers/mcp.js';
import { signedMail } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

const PLAIN = Buffer.from('From: Zed <zed@zed.example>\r\nTo: me@owner.example\r\nMessage-ID: <z1@zed.example>\r\n\r\nhi\r\n');
const trailDir = () => makeTmpDir('mp-mcpu-');
const twoWorld = (mcp) => makeWorld({ config: { v: 1, accounts: { a: account(trailDir()), b: account(trailDir()) }, ...(mcp ? { mcp } : {}) } });
const oneWorld = (mcp) => makeWorld({ config: { v: 1, accounts: { a: account(trailDir()) }, ...(mcp ? { mcp } : {}) } });
const worker0 = (a) => ({ ...mailproofOptions(a), worker: { size: 0 } });

test('schema: types, enum, bounds, items, required, additionalProperties', () => {
  const s = { type: 'object', required: ['n'], additionalProperties: false, properties: { n: { type: 'integer', minimum: 1, maximum: 5 }, e: { enum: ['x'] }, a: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }, u: { type: ['boolean', 'string'] }, o: { type: ['object', 'string'] } } };
  assert.equal(validate(s, { n: 1 }), null);
  assert.equal(validate(s, { n: 1, u: 'x', o: {}, a: ['q'] }), null);
  assert.match(validate(s, {}), /missing "n"/);
  assert.match(validate(s, { n: 1.5 }), /whole number/);
  assert.match(validate(s, { n: 0 }), /at least 1/);
  assert.match(validate(s, { n: 6 }), /at most 5/);
  assert.match(validate(s, { n: 1, e: 'y' }), /one of x/);
  assert.match(validate(s, { n: 1, a: [] }), /at least 1/);
  assert.match(validate(s, { n: 1, a: [1] }), /must be a string/);
  assert.match(validate(s, { n: 1, a: ['a', 'b', 'c'] }), /at most 2/);
  assert.match(validate(s, { n: 1, u: 3 }), /boolean or a string/);
  assert.match(validate(s, { n: 1, z: 1 }), /unknown argument "z"/);
  assert.match(validate(s, { n: 1, ['__proto__']: 1 }.constructor === Object ? { n: 1, constructor: 1 } : {}), /unknown argument "constructor"/);
});

test('errors: library code passes through, TypeError and UsageError are ERR_BAD_ARGUMENT, the rest ERR_INTERNAL; retryable is the exit-75 set', () => {
  assert.deepEqual(toErrorObject(Object.assign(new Error('x'), { code: 'ERR_TRAIL_LOCKED' })), { code: 'ERR_TRAIL_LOCKED', message: 'x', retryable: true });
  for (const c of ['ERR_SYNC_LOCKED', 'ERR_IMAP_CONNECT', 'ERR_IMAP_TIMEOUT', 'ERR_IMAP_THROTTLED', 'ERR_IMAP_UIDVALIDITY', 'EX_SECRET_COMMAND']) assert.equal(toErrorObject(Object.assign(new Error('x'), { code: c })).retryable, true, c);
  const auth = toErrorObject(Object.assign(new Error('secret-ish detail'), { code: 'ERR_IMAP_AUTH' }));
  assert.equal(auth.retryable, false); assert.match(auth.message, /refused the login/); assert.doesNotMatch(auth.message, /secret-ish/);
  assert.equal(toErrorObject(new TypeError('t')).code, 'ERR_BAD_ARGUMENT');
  assert.equal(toErrorObject(new UsageError('u')).code, 'ERR_BAD_ARGUMENT');
  assert.equal(toErrorObject(new ToolError('ERR_TOO_LARGE', 'big')).code, 'ERR_TOO_LARGE');
  assert.deepEqual(toErrorObject(new Error('boom')), { code: 'ERR_INTERNAL', message: 'boom', retryable: false });
  assert.equal(toErrorObject(Object.assign(new Error('e'), { code: 'ENOENT' })).code, 'ERR_INTERNAL');
  assert.equal(toErrorObject('plain string').code, 'ERR_INTERNAL');
});

test('readLines: lines split across chunks, a trailing line without newline, and an over-long line dropped once', async () => {
  const input = new Readable({ read() {} });
  const lines = []; let overflow = 0; let ended = false;
  readLines(input, { onLine: (l) => lines.push(l), onOverflow: () => { overflow++; }, onEnd: () => { ended = true; }, maxBytes: 20 });
  input.push('{"a":'); input.push('1}\n{"b":2}\n'); input.push('x'.repeat(50)); input.push('y'.repeat(50) + '\n{"c":3}\n'); input.push('{"d":4}'); input.push(null);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
  assert.equal(overflow, 1); assert.equal(ended, true);
});

test('protocol: a cancelled request is answered with nothing; notifications get no reply', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = createProtocol({ serverInfo: { name: 'x', title: 'x', version: '1' }, instructions: '', listTools: () => [], callTool: () => gate });
  const pending = p.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'slow' } });
  assert.equal(await p.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }), null);
  release({ content: [], isError: false });
  assert.equal(await pending, null);
});

test('one account: account is optional and a valid name is accepted; tools never touch the disk until used (lazy open), and only opened accounts are closed', async () => {
  const world = twoWorld();
  const made = []; const closed = [];
  const c = await inProcess(world, { deps: { makeMailproof: (a) => { const mp = new Mailproof(worker0(a)); made.push(a.name); const close = mp.close.bind(mp); mp.close = async () => { closed.push(a.name); return close(); }; return mp; } } });
  assert.deepEqual(made, [], 'construction opens nothing');
  await c.call('accounts');
  assert.deepEqual(made, [], 'accounts opens no trail');
  assert.equal((await c.call('list', { account: 'b' })).json.length, 0);
  assert.deepEqual(made, ['b']);
  await c.call('list', { account: 'b' });
  assert.deepEqual(made, ['b'], 'kept for the life of the process');
  await c.close();
  assert.deepEqual(closed, ['b']);
  const one = await inProcess(oneWorld());
  assert.equal((await one.call('list')).isError, false);
  assert.equal((await one.call('list', { account: 'a' })).isError, false);
  await one.close();
});

test('a broken trail of one account fails only the calls that name it', async () => {
  const world = twoWorld();
  const c = await inProcess(world, { deps: { makeMailproof: (a) => {
    const mp = new Mailproof(worker0(a));
    if (a.name === 'a') mp.list = async () => { throw Object.assign(new Error('flat trail'), { code: 'ERR_TRAIL_LAYOUT' }); };
    return mp;
  } } });
  assert.equal((await c.call('list', { account: 'b' })).isError, false);
  const bad = await c.call('list', { account: 'a' });
  assert.deepEqual([bad.isError, bad.error.code, bad.error.retryable], [true, 'ERR_TRAIL_LAYOUT', false]);
  assert.equal((await c.call('list', { account: 'b' })).isError, false, 'the server carries on');
  await c.close();
});

test('two accounts share one worker thread, not two (the pool key is the worker options)', async () => {
  const world = twoWorld();
  const good = await signedMail({ body: 'hello\r\n' });
  const workers = () => process.report.getReport().workers.length;
  const before = workers();
  const c = await inProcess(world, { deps: { makeMailproof: (a) => new Mailproof({ ...mailproofOptions(a), resolver: good.resolver }) } });
  for (const acct of ['a', 'b']) assert.equal((await c.call('check', { account: acct, base64: good.raw.toString('base64') })).json.portable.trust, 'verified');
  assert.equal(workers(), before + 1, 'N accounts, one warm worker');
  await c.close();
  assert.equal(workers(), before, 'closing every opened instance ends it');
});

test('a held trail lock is ERR_TRAIL_LOCKED with retryable true; a record racing it succeeds once the lock is gone', async () => {
  const world = oneWorld();
  const cfg = await loadConfig(world.configFile, world.env);
  const c = await inProcess(world, { deps: { makeMailproof: (a) => new Mailproof({ ...worker0(a), lockTimeoutMs: 150 }) } });
  const lock = path.join(cfg.accounts.a.trailDir, '.default.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: os.hostname(), started: new Date().toISOString() }));
  const r = await c.call('record', { base64: PLAIN.toString('base64'), direction: 'in' });
  assert.equal(r.error.code, 'ERR_TRAIL_LOCKED'); assert.equal(r.error.retryable, true);
  fs.rmSync(lock);
  assert.equal((await c.call('record', { base64: PLAIN.toString('base64'), direction: 'in' })).isError, false);
  await c.close();
});

test('sync: a per-call maxMessages default, overrides pass through, results and failures map, state and audit are written, IMAP never contacted', async () => {
  const world = oneWorld();
  const seen = [];
  const sync = async (mp, opts) => { seen.push(opts); return { complete: false, folders: [{ folder: 'INBOX', direction: 'in', attempted: true, complete: false, seen: 5, recorded: 5, duplicate: 0, over_limit: 0 }] }; };
  const c = await inProcess(world, { deps: { sync, makeMailproof: (a) => new Mailproof(worker0(a)) } });
  const r = await c.call('sync');
  assert.equal(r.json.complete, false); assert.equal(r.json.folders[0].recorded, 5);
  assert.equal(seen[0].maxMessages, SYNC_MAX_MESSAGES_DEFAULT);
  assert.deepEqual(seen[0].auth, { pass: 'not-used' }); assert.equal(JSON.stringify(r.json).includes('not-used'), false, 'the secret is never in a result');
  await c.call('sync', { maxMessages: 10, folders: ['X'], sent: false });
  assert.equal(seen[1].maxMessages, 10); assert.deepEqual(seen[1].folders, ['X']); assert.equal(seen[1].sent, false);
  assert.equal((await c.call('sync', { maxMessages: 5000 })).isError, false); assert.equal(seen[2].maxMessages, 1000, 'capped at the library ceiling');
  assert.equal((await c.call('sync', { maxMessages: 0 })).error.code, 'ERR_BAD_ARGUMENT');
  const state = JSON.parse(fs.readFileSync(path.join(world.stateDir, 'a', 'state.json'), 'utf8'));
  assert.equal(state.lastSync.recorded, 5);
  const audit = fs.readFileSync(path.join(world.stateDir, 'mcp.log'), 'utf8');
  assert.match(audit, /"tool":"sync"/); assert.match(audit, /ok recorded 5 \(not complete\)/); assert.equal(audit.includes('not-used'), false);
  await c.close();
  const failing = (code) => inProcess(world, { deps: { sync: async () => { throw Object.assign(new Error('x'), { code }); }, makeMailproof: (a) => new Mailproof(worker0(a)) } });
  const auth = await (await failing('ERR_IMAP_AUTH')).call('sync'); assert.deepEqual([auth.error.code, auth.error.retryable], ['ERR_IMAP_AUTH', false]);
  const locked = await (await failing('ERR_SYNC_LOCKED')).call('sync'); assert.deepEqual([locked.error.code, locked.error.retryable], ['ERR_SYNC_LOCKED', true]);
});

test('requests run concurrently: a ping and a read are answered while a sync is in flight', async () => {
  const world = oneWorld();
  let release; const gate = new Promise((r) => { release = r; });
  const c = await inProcess(world, { deps: { sync: async () => { await gate; return { complete: true, folders: [] }; }, makeMailproof: (a) => new Mailproof(worker0(a)) } });
  const slow = c.call('sync');
  assert.deepEqual((await c.request('ping')).result, {});
  assert.equal((await c.call('list')).json.length, 0);
  const [r1, r2] = await Promise.all([c.call('list'), c.call('counterparties')]);
  assert.equal(r1.isError || r2.isError, false);
  release();
  assert.equal((await slow).json.complete, true);
  await c.close();
});

test('shutdown: stdin end or an abort waits for in-flight calls, closes every opened Mailproof and returns 0', async () => {
  const world = oneWorld();
  const config = await loadConfig(world.configFile, world.env);
  let release; const gate = new Promise((r) => { release = r; });
  let closed = 0;
  const input = new Readable({ read() {} });
  const out = [];
  const ac = new AbortController();
  const done = serveMcp({
    config, env: world.env, version: 't', stdin: input, write: (s) => out.push(s), signal: ac.signal, graceMs: 3000,
    deps: { sync: async () => { await gate; return { complete: true, folders: [] }; }, makeMailproof: (a) => { const mp = new Mailproof(worker0(a)); const cl = mp.close.bind(mp); mp.close = async () => { closed++; return cl(); }; return mp; } },
  });
  input.push('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sync","arguments":{}}}\n');
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();                                  // SIGTERM while the call is slow
  let finished = false; void done.then(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(finished, false, 'it waits for the call in flight');
  release();
  assert.equal(await done, 0);
  assert.equal(closed, 1);
  assert.equal(JSON.parse(out.join('').trim()).result.isError, false, 'the in-flight call was answered before exit');
});

test('shutdown gives up on a call that never ends after the grace period', async () => {
  const world = oneWorld();
  const config = await loadConfig(world.configFile, world.env);
  const input = new Readable({ read() {} });
  const done = serveMcp({ config, env: world.env, version: 't', stdin: input, write: () => {}, graceMs: 100, deps: { sync: () => new Promise(() => {}), makeMailproof: (a) => new Mailproof(worker0(a)) } });
  input.push('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sync","arguments":{}}}\n');
  await new Promise((r) => setTimeout(r, 50));
  input.push(null);
  assert.equal(await done, 0);
});

test('a path swapped between the check and the open is refused (TOCTOU), and a regular file is read', async () => {
  const inDir = makeTmpDir('mp-mcpu-in-');
  const world = oneWorld({ inputDirs: [inDir] });
  const f = path.join(inDir, 'm.eml'); fs.writeFileSync(f, PLAIN);
  const other = path.join(inDir, 'other.eml'); fs.writeFileSync(other, Buffer.concat([PLAIN, PLAIN]));
  let swap = false;
  const c = await inProcess(world, { deps: { makeMailproof: (a) => new Mailproof(worker0(a)) }, afterPathCheck: async () => { if (swap) { fs.renameSync(other, f); } } });
  assert.equal((await c.call('check', { path: f })).isError, false);
  swap = true;
  const r = await c.call('check', { path: f });
  assert.equal(r.error.code, 'ERR_PATH_NOT_ALLOWED'); assert.match(r.error.message, /regular file inside/);
  await c.close();
});

test('the audit log: write and destructive calls only, never raw bytes, truncated to its last 1 MiB at start', async () => {
  const world = oneWorld();
  const config = await loadConfig(world.configFile, world.env);
  fs.mkdirSync(world.stateDir, { recursive: true });
  const log = path.join(world.stateDir, 'mcp.log');
  fs.writeFileSync(log, `${'old line\n'.repeat(200_000)}`);   // about 1.8 MiB
  const input = new Readable({ read() {} });
  const out = [];
  const done = serveMcp({ config, env: world.env, version: 't', stdin: input, write: (s) => out.push(s), deps: { makeMailproof: (a) => new Mailproof(worker0(a)) } });
  const call = (id, name, args) => input.push(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  call(1, 'record', { base64: PLAIN.toString('base64'), direction: 'in' });
  call(2, 'list', {});
  call(3, 'forget', { with: 'zed@zed.example' });
  await new Promise((r) => setTimeout(r, 1500));
  input.push(null); await done;
  const text = fs.readFileSync(log, 'utf8');
  const rows = text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert.ok(text.length < 1024 * 1024 + 2000, 'truncated to about 1 MiB');
  assert.deepEqual(rows.map((r) => r.tool).sort(), ['forget', 'record']);
  assert.equal(text.includes(PLAIN.toString('base64')), false, 'no raw bytes in the log');
  assert.ok(rows.every((r) => r.account === 'a' && typeof r.at === 'string' && r.outcome));
  assert.deepEqual(summarize({ base64: 'AAAA', ids: ['x', 'y'], profile: { a: 1 }, id: 'z'.repeat(300), n: 3 }), { base64: '<4 chars>', ids: '<2 item(s)>', profile: '<object>', id: `${'z'.repeat(120)}...`, n: 3 });
});

test('--log diagnostics go to the file, never stderr; an internal error is logged and reported as ERR_INTERNAL', async () => {
  const world = oneWorld();
  const config = await loadConfig(world.configFile, world.env);
  const logFile = path.join(world.root, 'diag.log');
  const input = new Readable({ read() {} });
  const out = [];
  const done = serveMcp({ config, env: world.env, version: 't', stdin: input, write: (s) => out.push(s), logFile, deps: { makeMailproof: () => { throw new Error('boom'); } } });
  input.push('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list","arguments":{}}}\n');
  await new Promise((r) => setTimeout(r, 200));
  input.push(null); await done;
  assert.equal(JSON.parse(out.join('').trim()).result.content[0].text.includes('ERR_INTERNAL'), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(fs.readFileSync(logFile, 'utf8'), /internal error in list/);
});

test('serve: a line over the cap closes that message with -32600 and the server carries on', async () => {
  const input = new Readable({ read() {} });
  const out = [];
  const protocol = createProtocol({ serverInfo: { name: 'x', title: 'x', version: '1' }, instructions: '', listTools: () => [], callTool: () => null });
  const done = serve({ input, write: (s) => out.push(JSON.parse(s)), protocol, maxLineBytes: 100 });
  input.push(`${'z'.repeat(500)}\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n`);
  input.push(null); await done;
  assert.equal(out[0].error.code, -32600); assert.deepEqual(out[1], { jsonrpc: '2.0', id: 1, result: {} });
});
