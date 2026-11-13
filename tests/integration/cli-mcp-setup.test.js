// The menu's mcp screen (SPEC B11.4d, C6): status, install / uninstall through `claude mcp`, and "other clients" (JSON printed and written to
// ~/mailproof/mcp/mcp.json). `claude` is injected: the real Claude Code config is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';

const keys = (...l) => `${l.join('\n')}\n`;
const world = () => makeWorld({ accounts: { t: account(makeTmpDir('mp-cli-mcps-')) }, });
const menu = (w, input, deps) => w.run([], { interactive: true, input, deps });
const GET_OK = { code: 0, stdout: 'mailproof:\n  Scope: User config (available in all your projects)\n  Status: connected\n  Command: mailproof\n  Args: mcp\n', stderr: '' };
const GET_NO = { code: 1, stdout: '', stderr: 'No MCP server found with name: mailproof' };
const fake = (get, calls) => ({ claude: async (args) => { calls.push(args); return args[1] === 'get' ? get : { code: 0, stdout: 'ok', stderr: '' }; } });

test('no claude binary: says so, prints the JSON, writes ~/mailproof/mcp/mcp.json (dir 0700, file 0600)', async () => {
  const w = world();
  const r = await menu(w, keys('19', 'q'), { claude: async () => null });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mailproof [›>] 19 mcp/);
  assert.match(r.stdout, /^Claude Code +the `claude` command was not found$/m);
  assert.match(r.stdout, /^ {6}"mailproof": \{$/m);
  assert.match(r.stdout, /^(ok|✓) saved to ~\/mailproof\/mcp\/mcp\.json$/m);
  assert.match(r.stdout, /copy this into your MCP client's config \(most clients use an mcpServers block\)/);
  const file = path.join(w.home, 'mailproof', 'mcp', 'mcp.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: { mailproof: { command: 'mailproof', args: ['mcp'] } } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok(!r.stdout.includes(w.home), 'no absolute home path');
  const again = await menu(w, keys('19', 'q'), { claude: async () => null });   // the same content again is fine
  assert.equal(again.code, 0);
});

test('not registered: status, the choice line under the rule, install runs exactly claude mcp add --scope user only after y', async () => {
  const w = world();
  const calls = [];
  const no = await menu(w, keys('19', '1', 'n', 'q'), fake(GET_NO, calls));
  assert.match(no.stdout, /^Claude Code +not registered$/m);
  assert.match(no.stdout, /^Config +\S+config\.json$/m);
  assert.match(no.stdout, /^Log +\S+mcp\.log$/m);
  assert.match(no.stdout, /^Input dirs +\S*mailproof \(default\)$/m, 'the effective folders: the CLI\'s own');
  assert.match(no.stdout, /^Output dir +\S*mailproof\/\{exports,backups,saved\} \(default\)$/m);
  assert.match(no.stdout, /^[─-]+\n1 install in Claude Code {2}3 other clients$/m, 'C10: the rule above the choice line; nothing to uninstall');
  assert.match(no.stdout, /^nothing changed$/m);
  assert.deepEqual(calls.filter((a) => a[1] !== 'get'), []);
  const yes = await menu(w, keys('19', '1', 'y', 'q'), fake(GET_NO, calls));
  assert.deepEqual(calls.filter((a) => a[1] !== 'get').at(-1), ['mcp', 'add', '--scope', 'user', 'mailproof', '--', 'mailproof', 'mcp']);
  assert.match(yes.stdout, /registered in Claude Code \(user scope\); restart Claude Code/);
});

test('registered: status shows scope and command; uninstall runs claude mcp remove --scope user after y; 3 prints the JSON', async () => {
  const w = world();
  const calls = [];
  const r = await menu(w, keys('19', '2', 'y', 'q'), fake(GET_OK, calls));
  assert.match(r.stdout, /^[─-]+\n1 reinstall {2}2 uninstall {2}3 other clients$/m, 'registered: reinstall, uninstall, other');
  assert.match(r.stdout, /^Claude Code +(ok|✓) registered for all your projects \(user scope\): mailproof mcp$/m);
  assert.deepEqual(calls.filter((a) => a[1] !== 'get').at(-1), ['mcp', 'remove', '--scope', 'user', 'mailproof']);
  assert.match(r.stdout, /removed from Claude Code/);
  const other = await menu(w, keys('19', '3', 'q'), fake(GET_OK, calls));
  assert.match(other.stdout, /^(ok|✓) saved to ~\/mailproof\/mcp\/mcp\.json$/m);
  const back = await menu(w, keys('19', '', 'q'), fake(GET_OK, calls));
  assert.equal(back.code, 0);
});

test('the other scopes read plain too', async () => {
  const w = world();
  for (const [scope, want] of [['Project config (shared via .mcp.json)', /registered for this project \(project scope\)/], ['Local config (private to you in this project)', /registered for you in one project \(local scope\)/]]) {
    const r = await menu(w, keys('19', '', 'q'), fake({ ...GET_OK, stdout: GET_OK.stdout.replace(/Scope: .*/, `Scope: ${scope}`) }, []));
    assert.match(r.stdout, want);
  }
});

test('not registered: 2 is not a choice (nothing to uninstall)', async () => {
  const w = world();
  const calls = [];
  await menu(w, keys('19', '2', 'q'), fake(GET_NO, calls));
  assert.deepEqual(calls.filter((a) => a[1] !== 'get'), []);
});

test('reinstall: asks first, then removes and adds (user scope), in that order', async () => {
  const w = world();
  const calls = [];
  const no = await menu(w, keys('19', '1', 'n', 'q'), fake(GET_OK, calls));
  assert.match(no.stdout, /^nothing changed$/m);
  assert.deepEqual(calls.filter((a) => a[1] !== 'get'), []);
  const yes = await menu(w, keys('19', '1', 'y', 'q'), fake(GET_OK, calls));
  assert.deepEqual(calls.filter((a) => a[1] !== 'get'), [['mcp', 'remove', '--scope', 'user', 'mailproof'], ['mcp', 'add', '--scope', 'user', 'mailproof', '--', 'mailproof', 'mcp']]);
  assert.match(yes.stdout, /registered in Claude Code \(user scope\); restart Claude Code/);
});

test('a failing claude is reported, not hidden', async () => {
  const w = world();
  const r = await menu(w, keys('19', '1', 'y', 'q'), { claude: async (a) => (a[1] === 'get' ? GET_NO : { code: 1, stdout: '', stderr: 'boom \x1b[31mred' }) });
  assert.match(r.stderr, /claude mcp add failed: boom/);
  assert.ok(!r.stderr.includes('\x1b[31m'), 'terminal-safe');
});
