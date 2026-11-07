// One measurement per process (so maxRSS is per measurement). Prints `RESULT {json}`; exits 2 on any answer that
// differs from the full-read answer ("fail loudly").
// Modes (all take <N> = trail size, trail at .tmp/trail-<N> or $TRAILS/trail-<N>):
//   select <N>              pick the query inputs from the data (streaming), write q.json
//   full <N> <R> <query>    strategy C: the library's own Mailproof#list/#copies + a naive message_id scan, one query per process; writes ans/<query>.json (the reference answer)
//   rebuild <engine> <N>    cold rebuild of the index from the records (fresh process)
//   queries <engine> <N> [R] open/HEAD check + every query timed, each answer asserted equal to the C answers
//   dlog <N> [R]            strategy D: list via `git log`, compared to the C answers (mismatch is reported, not fatal)
//   insert <engine> <N> <from> <K1> <K2>  commit K1 records through commitRecord() + index insert; then K2 commits
//                           without the index and a catch-up open; verify against a full read
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Mailproof } from '../../src/index.js';
import { listIds, readRecord, commitRecord, RECORD_ID_RE } from '../../src/proof/trail.js';
import { git } from '../../src/proof/git.js';
import { openIndex, closeIndex, queries, onCommitted, idxFile, headOf, openDb } from './index.mjs';

const [mode, ...args] = process.argv.slice(2);
const TRAILS = process.env.TRAILS || path.join(import.meta.dirname, '.tmp');
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const ms = (t0) => performance.now() - t0;
const rssMB = () => Math.round(process.resourceUsage().maxRSS / 1024);
const emit = (o) => console.log('RESULT ' + JSON.stringify(o));
const fail = (m) => { console.error('FAIL: ' + m); process.exit(2); };
const timeIt = async (fn, R) => { await fn(); const t = []; for (let i = 0; i < R; i++) { const t0 = performance.now(); await fn(); t.push(ms(t0)); } return median(t); };

const engineOrN = ['rebuild', 'queries', 'insert'].includes(mode) ? args : [undefined, ...args];
const [engine, nArg, ...rest] = engineOrN;
const N = Number(nArg);
const trailDir = path.join(TRAILS, `trail-${N}`);
const root = path.join(trailDir, 't');
const qFile = path.join(trailDir, 'q.json'), ansDir = path.join(trailDir, 'ans');
const loadRef = () => { const Q = JSON.parse(fs.readFileSync(qFile)); return { Q, answers: Object.fromEntries(Object.keys(Q).map((n) => [n, JSON.parse(fs.readFileSync(path.join(ansDir, n + '.json')))])) }; };

const fullByMessageId = async (mid) => {
  const all = (await Promise.all((await listIds(root)).map((id) => readRecord(root, id)))).filter(Boolean);
  return all.filter((r) => r.message?.message_id === mid).sort((a, b) => (a.captured < b.captured ? -1 : a.captured > b.captured ? 1 : 0)).map((r) => r.id);
};

const LISTS = { list10: { limit: 10 }, list10in: { limit: 10, direction: 'in' }, list10out: { limit: 10, direction: 'out' }, list1000: { limit: 1000 } };

if (mode === 'select') {
  // choose the query inputs from the data itself, streaming (a compact tuple per record, never the records)
  const byKey = new Map(); const contained = new Map(); let nullKey = null;
  const ids = await listIds(root);
  for (let i = 0; i < ids.length; i += 500) {
    for (const r of await Promise.all(ids.slice(i, i + 500).map((id) => readRecord(root, id)))) {
      if (!r.message_key) { nullKey ??= r.id; } else { const g = byKey.get(r.message_key) || []; g.push([r.id, r.message?.message_id, r.captured]); byKey.set(r.message_key, g); }
      for (const o of r.copy?.evidence?.attached_original || []) if (o.message_key) contained.set(o.message_key, (contained.get(o.message_key) || 0) + 1);
    }
  }
  const keyMulti = [...byKey].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))[0];
  const keyCont = [...contained].filter(([k]) => byKey.has(k)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const lastOfMulti = [...keyMulti[1]].sort((a, b) => (a[2] < b[2] ? -1 : 1)).pop();
  const Q = {
    ...Object.fromEntries(Object.entries(LISTS).map(([n, o]) => [n, { fn: 'list', arg: o }])),
    copiesKeyMulti: { fn: 'copies', arg: keyMulti[0] },
    copiesIdOfMulti: { fn: 'copies', arg: lastOfMulti[0] },
    copiesKeyContained: { fn: 'copies', arg: keyCont[0] },
    copiesNullKeyId: { fn: 'copies', arg: nullKey },
    copiesUnknownKey: { fn: 'copies', arg: 'f'.repeat(32) },
    midMulti: { fn: 'mid', arg: keyMulti[1][0][1] },
    midUnknown: { fn: 'mid', arg: '<nobody@nowhere.example>' },
  };
  fs.writeFileSync(qFile, JSON.stringify(Q));
  emit({ mode, N, queries: Object.keys(Q).length, keyMultiCopies: keyMulti[1].length, keyContainedIn: keyCont[1], rssMB: rssMB() });
} else if (mode === 'full') {
  // strategy C: the library's own Mailproof#list/#copies (+ a naive message_id scan). One query per process: its RSS is its own.
  const name = rest[1]; const R = Number(rest[0] ?? 3);
  const Q = JSON.parse(fs.readFileSync(qFile))[name];
  const mp = new Mailproof({ trailDir, trail: 't', worker: { size: 0 } });
  const run = () => (Q.fn === 'list' ? mp.list(Q.arg) : Q.fn === 'copies' ? mp.copies(Q.arg) : fullByMessageId(Q.arg));
  const t = []; let ans;
  for (let i = 0; i < R; i++) { const t0 = performance.now(); ans = await run(); t.push(ms(t0)); }
  fs.mkdirSync(ansDir, { recursive: true });
  fs.writeFileSync(path.join(ansDir, name + '.json'), JSON.stringify(ans));
  emit({ mode, N, name, R, medianMs: +median(t).toFixed(1), allMs: t.map((x) => Math.round(x)), rssMB: rssMB() });
} else if (mode === 'rebuild') {
  const f = idxFile(trailDir, 't', engine);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(f + s, { force: true });
  const t0 = performance.now();
  const ix = await openIndex(engine, trailDir, 't');
  const t = ms(t0);
  if (ix.mode !== 'rebuild') fail('expected rebuild, got ' + ix.mode);
  const n = queries(ix).count();
  closeIndex(ix);
  emit({ mode, engine, N, rebuildMs: Math.round(t), rssMB: rssMB(), rows: n, fileMB: +(fs.statSync(f).size / 1e6).toFixed(1), walLeft: fs.existsSync(f + '-wal') });
} else if (mode === 'queries') {
  const R = Number(rest[0] ?? 15);
  const ref = loadRef();
  const tI = performance.now();
  if (engine === 'node-sqlite') await import('node:sqlite'); else (await import('node:module')).createRequire(import.meta.url)('better-sqlite3');
  const importMs = ms(tI);
  const t0 = performance.now();
  let ix = await openIndex(engine, trailDir, 't');
  const firstOpenMs = ms(t0);
  if (ix.mode !== 'fresh') fail('index was not up to date: ' + ix.mode);
  closeIndex(ix);
  const openMs = await timeIt(async () => { closeIndex(await openIndex(engine, trailDir, 't')); }, 9);
  const headMs = await timeIt(() => headOf(root), 9);
  const headFileMs = await timeIt(async () => { const h = fs.readFileSync(path.join(root, '.git/HEAD'), 'utf8').trim(); fs.readFileSync(path.join(root, '.git', h.slice(5)), 'utf8'); }, 9);
  ix = await openIndex(engine, trailDir, 't');
  const q = queries(ix);
  const med = {}; const fnOf = (c) => (c.fn === 'list' ? () => q.list(c.arg) : c.fn === 'copies' ? () => q.copies(c.arg) : () => q.byMessageId(c.arg));
  for (const [name, c] of Object.entries(ref.Q)) {
    const f = fnOf(c);
    try { assert.deepStrictEqual(f(), ref.answers[name]); } catch (e) { fail(`${engine} N=${N} ${name} differs from the full read\n${e.message.slice(0, 600)}`); }
    const t = []; for (let i = 0; i < R; i++) { const a = performance.now(); f(); t.push(ms(a)); }
    med[name] = Math.round(median(t) * 1000); // microseconds
  }
  closeIndex(ix);
  emit({ mode, engine, N, importMs: Math.round(importMs * 10) / 10, firstOpenMs: Math.round(firstOpenMs * 10) / 10, openMs: +openMs.toFixed(2), headRevParseMs: +headMs.toFixed(2), headFileMs: +headFileMs.toFixed(3), medianUs: med, answersEqualToFullRead: Object.keys(ref.Q).length, rssMB: rssMB() });
} else if (mode === 'dlog') {
  const R = Number(rest[0] ?? 7);
  const ref = loadRef();
  const logList = async ({ limit, direction }) => {
    const out = await git(root, ['log', '-n', String(limit), '-E', '--grep', `^record [0-9a-f]{12} ${direction || '(in|out)'} `, '--name-only', '--format=%x01%s']);
    const ids = out.split('\x01').flatMap((c) => c.split('\n').filter((l) => /^records\/[0-9a-f]{32}\.json$/.test(l)).map((l) => l.slice(8, 40)));
    const recs = await Promise.all(ids.map((id) => readRecord(root, id)));
    return recs.filter(Boolean).map((r) => ({ id: r.id, captured: r.captured, direction: r.direction, live: r.verdicts?.live?.trust, portable: r.verdicts?.portable?.trust, message_id: r.message?.message_id ?? null }));
  };
  const res = {};
  for (const name of ['list10', 'list10in', 'list10out', 'list1000']) {
    const o = ref.Q[name].arg;
    const got = await logList(o);
    let same = true; try { assert.deepStrictEqual(got, ref.answers[name]); } catch { same = false; }
    res[name] = { medianMs: +(await timeIt(() => logList(o), R)).toFixed(1), equalToFullRead: same };
  }
  // how often would D have been right? top-10 by commit order vs by captured, for each trail prefix of the last 2000 commits
  const subj = (await git(root, ['log', '--reverse', '--format=%s'])).split('\n').filter((l) => l.startsWith('record '));
  const idByPrefix = new Map(); for (const id of await listIds(root)) idByPrefix.set(id.slice(0, 12), id);
  const recs = await Promise.all(subj.map((l) => readRecord(root, idByPrefix.get(l.slice(7, 19)))));
  const prefixCheck = (pred) => {
    let best = [], tot = 0, ok = 0, tail = [];
    recs.forEach((r, i) => {
      if (!pred(r)) return;
      best.push(r); best.sort((a, b) => (a.captured < b.captured ? 1 : -1)); best = best.slice(0, 10);
      tail.push(r.id); if (tail.length > 10) tail.shift();
      if (i >= recs.length - 2000) { tot++; if (best.map((x) => x.id).join() === [...tail].reverse().join()) ok++; }
    });
    return { prefixes: tot, topTenEqual: ok };
  };
  emit({ mode, N, res, prefixAll: prefixCheck(() => true), prefixIn: prefixCheck((r) => r.direction === 'in'), rssMB: rssMB() });
} else if (mode === 'insert') {
  const [from, k1, k2] = rest.map(Number);
  const pending = JSON.parse(fs.readFileSync(path.join(trailDir, 'pending.json')));
  const mine = pending.slice(from, from + k1 + k2);
  const t0 = performance.now();
  let ix = await openIndex(engine, trailDir, 't');
  const initial = { mode: ix.mode, ms: Math.round(ms(t0)) };
  const commitMs = [], insertMs = [];
  const commit = async (r) => (await commitRecord(root, 't', { record: r, keyFiles: [], message: `record ${r.id.slice(0, 12)} ${r.direction} ${r.verdicts.live.trust}/${r.verdicts.portable.trust}`, now: () => new Date(r.captured) })).commit;
  for (const r of mine.slice(0, k1)) {
    const a = performance.now(); const head = await commit(r); commitMs.push(ms(a));
    const b = performance.now(); onCommitted(ix, r, head); insertMs.push(ms(b));
  }
  // an insert done twice must be a no-op on the answers (idempotent), and the HEAD stored must be the real HEAD
  if ((await headOf(root)) !== ix.s.getMeta.get('head').v) fail('stored head != HEAD after inserts');
  closeIndex(ix);
  const stale = [];
  for (const r of mine.slice(k1)) { const a = performance.now(); await commit(r); stale.push(ms(a)); }
  const c0 = performance.now();
  ix = await openIndex(engine, trailDir, 't');
  const catchupMs = ms(c0);
  if (ix.mode !== 'catchup') fail('expected catchup, got ' + ix.mode);
  // verify against a full read of the mutated trail
  const q = queries(ix);
  const ids = await listIds(root);
  if (q.count() !== ids.length) fail(`index has ${q.count()} rows, trail has ${ids.length}`);
  const mp = new Mailproof({ trailDir, trail: 't', worker: { size: 0 } });
  for (const o of [{ limit: 10 }, { limit: 10, direction: 'in' }]) assert.deepStrictEqual(q.list(o), await mp.list(o), 'list after inserts/catch-up');
  for (const r of mine.filter((_, i) => i % 17 === 0)) assert.deepStrictEqual(q.copies(r.id), await mp.copies(r.id), 'copies after inserts/catch-up');
  closeIndex(ix);
  emit({ mode, engine, N, initial, k1, k2, commitMedianMs: +median(commitMs).toFixed(1), insertMedianMs: +median(insertMs).toFixed(2), staleCommitMedianMs: +median(stale).toFixed(1), catchupMs: Math.round(catchupMs), catchupRecords: k2, verifiedAfter: true, rssMB: rssMB() });
} else fail('unknown mode ' + mode);
