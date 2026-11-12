// `update` (SPEC B11.10) and its menu item: a development link is updated with git (no npm offered), a real install is looked up first (offline says
// so), up to date asks nothing, a real upgrade says to restart, npm's own output shows only on failure. The registry and npm are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { version } from '../../src/cli/version.js';

const keys = (...l) => `${l.join('\n')}\n`;
const world = () => makeWorld({ accounts: { t: account(makeTmpDir('mp-cli-upd-')) } });
const NEXT = '99.0.0';

test('a development link says so and never offers npm (subcommand, --run and menu)', async () => {
  const w = world();
  const calls = [];
  const deps = { installInfo: () => ({ dev: true, dir: `${w.home}/src/mailproof` }), npmView: async () => { throw new Error('must not look up'); }, runNpm: async (a) => { calls.push(a); return 0; } };
  for (const argv of [['update'], ['update', '--check'], ['update', '--run']]) {
    const r = await w.run(argv, { deps });
    assert.equal(r.code, 0, argv.join(' '));
    assert.match(r.stdout, /^mailproof \d+\.\d+\.\d+: development link to ~\/src\/mailproof; update with git/m);
    assert.ok(!r.stdout.includes(w.home), 'no absolute home path');
  }
  const m = await w.run([], { interactive: true, input: keys('update', 'q'), deps });
  assert.match(m.stdout, /development link to ~\/src\/mailproof/);
  assert.ok(!m.stdout.includes('Upgrade now?') && !m.stdout.includes('npm install'), 'no npm offered');
  assert.deepEqual(calls, []);
});

test('a real install: up to date asks nothing; a newer version is offered once; offline says so', async () => {
  const w = world();
  const calls = [];
  const dep = (latest) => ({ installInfo: () => ({ dev: false, dir: '/usr/lib/node_modules/mailproof' }), npmView: async () => latest, runNpm: async (a) => { calls.push(a); return 0; } });
  const same = await w.run([], { interactive: true, input: keys('update', 'q'), deps: dep(version()) });
  assert.match(same.stdout, new RegExp(`mailproof ${version().replaceAll('.', '\\.')} is up to date`));
  assert.ok(!same.stdout.includes('Upgrade now?'));
  const off = await w.run([], { interactive: true, input: keys('update', 'q'), deps: dep(null) });
  assert.match(off.stdout, /the npm registry could not be reached/);
  assert.ok(!off.stdout.includes('Upgrade now?'));
  const no = await w.run([], { interactive: true, input: keys('update', 'n', 'q'), deps: dep(NEXT) });
  assert.match(no.stdout, new RegExp(`${NEXT.replaceAll('.', '\\.')} is available`));
  assert.match(no.stdout, /^[─-]+\nUpgrade now\? \[y\/N\] /m, 'C10: the separator above the question');
  assert.deepEqual(calls, []);
  const yes = await w.run([], { interactive: true, input: keys('update', 'y', 'q'), deps: dep(NEXT) });
  assert.match(yes.stdout, new RegExp(`upgraded to ${NEXT.replaceAll('.', '\\.')}: restart mailproof to use ${NEXT.replaceAll('.', '\\.')}`));
  assert.deepEqual(calls, [['install', '-g', 'mailproof@latest']]);
});

test('update --run: up to date installs nothing; offline is exit 1; a failing npm is exit 1; plain update never touches the network', async () => {
  const w = world();
  const calls = [];
  const dep = (latest, code = 0) => ({ installInfo: () => ({ dev: false, dir: '/usr/lib/node_modules/mailproof' }), npmView: async () => { if (latest === 'never') throw new Error('network used'); return latest; }, runNpm: async (a) => { calls.push(a); return code; } });
  const same = await w.run(['update', '--run'], { deps: dep(version()) });
  assert.equal(same.code, 0); assert.match(same.stdout, /nothing to install/);
  assert.equal((await w.run(['update', '--run'], { deps: dep(null) })).code, 1);
  assert.equal((await w.run(['update', '--run'], { deps: dep(NEXT, 3) })).code, 1);
  assert.match((await w.run(['update', '--run'], { deps: dep(NEXT, 3) })).stderr, /npm install -g mailproof@latest failed/);
  assert.equal(calls.length, 2, 'npm ran only for a newer version');
  const plain = await w.run(['update'], { deps: dep('never') });
  assert.equal(plain.code, 0);
  assert.match(plain.stdout, /^mailproof \d+\.\d+\.\d+ installed\. To upgrade: npm install -g mailproof@latest\n$/);
  const j = JSON.parse((await w.run(['update', '--check', '--json'], { deps: dep(NEXT) })).stdout);
  assert.deepEqual([j.latest, j.upToDate], [NEXT, false]);
});
