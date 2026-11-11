// Scripted driver: spawns server.js, drives the MCP lifecycle and every error case, asserts, prints latencies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildTrail } from './trail.mjs';

const t = await buildTrail();
await t.mp.close();
const child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], {
  env: { ...process.env, MAILPROOF_POC_TRAIL_DIR: t.dir }, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
const waiters = []; let buf = ''; const stdoutLines = [];
child.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); stdoutLines.push(l); waiters.shift()?.(l); }
});
const nextLine = () => new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('timeout')), 20000); waiters.push((l) => { clearTimeout(to); res(l); }); });
const rpc = async (o) => { const p = nextLine(); child.stdin.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`); return JSON.parse(await p); };
const timed = async (o) => { const s = performance.now(); const r = await rpc(o); return [r, performance.now() - s]; };
const text = (r) => r.result.content[0].text;
const lat = {};
let n = 0; const ok = (name) => { n++; console.log(`ok ${n} ${name}`); };

const t0 = performance.now();
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'run', version: '1' } } });
lat.startupToInitialize = performance.now() - t0;
assert.equal(init.result.protocolVersion, '2025-06-18'); assert.ok(init.result.capabilities.tools); assert.equal(init.result.serverInfo.name, 'mailproof-poc'); ok('initialize echoes a supported version');
assert.equal((await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-11-25'); ok('initialize: unsupported version gets the latest');
child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","method":"notifications/whatever","params":{}}\n'); // no replies expected
assert.deepEqual((await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {}); ok('notifications (known, unknown) get no reply; ping -> {}');
const [tl, dTl] = await timed({ jsonrpc: '2.0', id: 4, method: 'tools/list' }); lat['tools/list'] = dTl;
assert.deepEqual(tl.result.tools.map((x) => x.name), ['list', 'show', 'verify', 'replyFacts', 'counterparties']);
for (const x of tl.result.tools) { assert.equal(x.inputSchema.type, 'object'); assert.ok(x.description); assert.equal(x.run, undefined); } ok('tools/list: 5 tools with JSON Schema');

const call = async (name, args, id = 10) => timed({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
let [r, d] = await call('list', {}); lat.list = d;
const rows = JSON.parse(text(r)); assert.ok(!r.result.isError); assert.equal(rows.length, 6); ok('list returns 6 records');
const id = t.ids.signed;
[r, d] = await call('show', { id }); lat.show = d; assert.equal(JSON.parse(text(r)).id, id); ok('show');
[r, d] = await call('verify', { id }); lat.verify = d; assert.equal(JSON.parse(text(r)).ok, true); ok('verify ok:true');
[r, d] = await call('replyFacts', { messageId: t.reqMessageId }); lat.replyFacts = d; assert.equal(JSON.parse(text(r)).length, 3); ok('replyFacts: 3 direct replies');
[r, d] = await call('counterparties', { limit: 2 }); lat.counterparties = d; assert.equal(JSON.parse(text(r)).length, 2); ok('counterparties limit');
[r] = await call('list', { with: 'bob@beta.example', direction: 'in' }); assert.ok(JSON.parse(text(r)).length >= 1); ok('list filtered');

// tool errors are results, not protocol errors
[r] = await call('show', { id: 'f'.repeat(32) }); assert.equal(r.result.isError, true); assert.equal(r.error, undefined); ok('show unknown id: isError result');
[r] = await call('verify', {}); assert.equal(r.result.isError, true); ok('missing required arg: isError result');
[r] = await call('list', { limit: 'x' }); assert.equal(r.result.isError, true); ok('wrong arg type: isError result');
[r] = await call('list', { direction: 'sideways' }); assert.equal(r.result.isError, true); ok('enum violation: isError result');
[r] = await call('list', { bogus: 1 }); assert.equal(r.result.isError, true); ok('unknown argument: isError result');
[r] = await call('replyFacts', { messageId: '' }); assert.equal(r.result.isError, true); assert.match(text(r), /messageId/); ok('library TypeError surfaces as isError');

// protocol errors
assert.equal((await rpc('{not json')).error.code, -32700); ok('-32700 parse error (id null)');
assert.deepEqual(await rpc('{"jsonrpc":"2.0","id":5}'), { jsonrpc: '2.0', id: 5, error: { code: -32600, message: 'invalid request' } }); ok('-32600 no method');
assert.equal((await rpc('{"jsonrpc":"1.0","id":6,"method":"ping"}')).error.code, -32600); ok('-32600 wrong jsonrpc');
assert.equal((await rpc('[]')).error.code, -32600); ok('-32600 empty batch');
assert.equal((await rpc('"hello"')).error.code, -32600); ok('-32600 non-object');
assert.equal((await rpc({ jsonrpc: '2.0', id: 7, method: 'nope/x' })).error.code, -32601); ok('-32601 method not found');
assert.equal((await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602); ok('-32602 unknown tool');
assert.equal((await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} })).error.code, -32602); ok('-32602 no tool name');
assert.equal((await rpc({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list', arguments: [] } })).error.code, -32602); ok('-32602 arguments not an object');
assert.equal((await rpc({ jsonrpc: '2.0', id: 12, method: 'initialize', params: {} })).error.code, -32602); ok('-32602 initialize without version');
const batch = await rpc('[{"jsonrpc":"2.0","id":20,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","id":21,"method":"ping"}]');
assert.deepEqual(batch.map((x) => x.id), [20, 21]); ok('batch: notification omitted');
assert.equal((await rpc({ jsonrpc: '2.0', id: 'str-id', method: 'ping' })).id, 'str-id'); ok('string id echoed');

// every stdout line was valid JSON-RPC (nothing but protocol)
for (const l of stdoutLines) { const j = JSON.parse(l); assert.ok(Array.isArray(j) || j.jsonrpc === '2.0'); } ok(`stdout carried only protocol (${stdoutLines.length} lines)`);
assert.equal(stderr, ''); ok('stderr empty without MAILPROOF_POC_LOG');
// clean exit on stdin end
const exit = new Promise((res) => child.on('exit', (c, s) => res([c, s])));
child.stdin.end();
assert.deepEqual(await exit, [0, null]); ok('stdin end: exit code 0');

console.log('latency ms', JSON.stringify(Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, +v.toFixed(1)]))));
process.exit(0);
