// CLI --json and the MCP tool return the SAME library result for the same operation (owner decision 2026-11-12): the CLI may wrap
// multi-account output keyed by account name, nothing else. One fixture trail, each operation through both, deep equality.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bundleWorld, fakeOts } from '../helpers/bundle.js';
import { makeWorld, account } from '../helpers/cli.js';
import { inProcess } from '../helpers/mcp.js';
import { makeTmpDir } from '../helpers/tmp.js';

const BOB = 'bob@bob.example';
const subj = '[addypin] weekly stats =?utf-8?Q?=E2=80=94?= 2026-W45';

async function setup() {
  const ots = fakeOts();
  const w = bundleWorld({ otsBin: ots.bin });
  const a = await w.rec({ who: BOB, tag: 'a', subject: subj });
  await w.rec({ who: BOB, tag: 'b', out: true, subject: 'Re: stats' });
  await w.rec({ who: 'carol@carol.example', tag: 'c' });
  const inDir = makeTmpDir('mp-jp-in-');
  const world = makeWorld({ config: { v: 1, accounts: { work: account(w.trailDir) }, mcp: { inputDirs: [inDir], outputDir: makeTmpDir('mp-jp-out-') } } });
  const deps = { makeMailproof: () => w.mp, now: w.now };
  const m = await inProcess(world, { deps });
  const cli = async (argv) => { const r = await world.run([...argv, '--account', 'work'], { deps }); assert.ok(r.code === 0 || r.code === 2, `${argv.join(' ')}: ${r.code} ${r.stderr}`); return JSON.parse(r.stdout); };
  return { w, a, m, cli, inDir, world };
}
const mcp = async (s, name, args = {}) => { const r = await s.m.call(name, name === 'verifyBundle' ? args : { account: 'work', ...args }); assert.equal(r.isError, false, r.text); return r.json; };

test('status: one builder, the same per-account object (the refresh mode is the only difference)', async () => {
  const s = await setup();
  await s.w.mp.status({ refresh: true });
  const c = (await s.cli(['status', '--json'])).work;
  const m = await mcp(s, 'status');
  assert.deepEqual({ ...c, version: null }, { ...m, version: null }, 'the MCP server under test is built with version "test"');
  assert.deepEqual(Object.keys(c.records).sort(), ['in', 'newest', 'oldest', 'out', 'total', 'totalSource', 'unverified', 'verified']);
  assert.equal(typeof c.version, 'string'); assert.equal(c.config.ok, true);
  await s.m.close();
});

test('verify <address>: the CLI --json is the library verifyWith result (records, counted, verified, not_verified, sent_copies)', async () => {
  const s = await setup();
  const c = await s.cli(['verify', BOB, '--json']);
  const m = await mcp(s, 'verifyWith', { target: BOB });
  assert.deepEqual(c, m);
  assert.ok(Array.isArray(c.records) && !('results' in c));
  await s.m.close();
});

test('list --subject, people and replies <address>: the same rows through the CLI and the MCP tool', async () => {
  const s = await setup();
  assert.deepEqual(await s.cli(['list', '--subject', 'stats', '--json']), await mcp(s, 'list', { subject: 'stats' }));
  assert.deepEqual(await s.cli(['replies', BOB, '--json']), await mcp(s, 'replyFacts', { address: BOB }));
  assert.deepEqual(await s.cli(['people', '--json']), await mcp(s, 'counterparties'));
  await s.m.close();
});

const noId = ({ id: _id, ...rest }) => rest;   // a single-record CLI result also names the id it resolved from a prefix: the only addition

test('check (a trust profile), verify <id> and verify-bundle: the same result through both', async () => {
  const s = await setup();
  fs.mkdirSync(path.join(s.world.cfgDir, 'mailproof', 'profiles'), { recursive: true });
  const prof = 'bobs';
  fs.writeFileSync(path.join(s.world.cfgDir, 'mailproof', 'profiles', 'bobs.json'), JSON.stringify({ senders: ['@bob.example'], checks: { dkimAligned: true } }));
  assert.deepEqual(noId(await s.cli(['check', s.a.id, '--profile', prof, '--json'])), await mcp(s, 'checkProfile', { id: s.a.id, profile: prof }));
  assert.deepEqual(noId(await s.cli(['verify', s.a.id, '--json'])), await mcp(s, 'verify', { id: s.a.id }));
  const out = path.join(makeTmpDir('mp-jp-b-'), 'bundle');
  await s.w.mp.export({ with: [BOB], out });
  fs.cpSync(out, path.join(s.inDir, 'bundle'), { recursive: true });
  const b = path.join(s.inDir, 'bundle');
  assert.deepEqual(await s.cli(['verify-bundle', b, '--json']), await mcp(s, 'verifyBundle', { dir: b }));
  await s.m.close();
});

test('forget preview: a selection of rows (id, captured, direction, from, subject decoded), the same in the library, the CLI --dry-run --json and the MCP preview', async () => {
  const s = await setup();
  const lib = await s.w.mp.forget({ with: BOB }, { dryRun: true });
  assert.equal(lib.selection.length, 2);
  assert.deepEqual(Object.keys(lib.selection[0]).sort(), ['captured', 'direction', 'from', 'id', 'subject']);
  assert.ok(lib.selection.some((r) => r.subject === '[addypin] weekly stats — 2026-W45'));
  assert.equal(lib.selectionMore, 0);
  const c = await s.cli(['forget', '--with', BOB, '--dry-run', '--json']);
  assert.deepEqual(c, { dryRun: true, ...lib });
  const m = await mcp(s, 'forget', { with: BOB });
  assert.deepEqual(m.preview, lib);
  await s.m.close();
});
