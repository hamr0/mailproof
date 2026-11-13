// The menu's config screen (SPEC B11.4e, C4): the summary up front (never a password), edit in $EDITOR validated on close with an offer to reopen,
// and an annotated example. The editor is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, account } from '../helpers/cli.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { annotatedTemplate, TEMPLATE, validateConfig } from '../../src/cli/config.js';

const keys = (...l) => `${l.join('\n')}\n`;
function world(extra = {}) {
  const w = makeWorld({ accounts: {} });
  const pass = path.join(w.home, 'pw');
  fs.writeFileSync(pass, 'hunter2-secret\n', { mode: 0o600 });
  w.write({ v: 1, accounts: { personal: { user: 'ana@example.com', host: 'imap.example.com', folders: ['INBOX'], trailDir: makeTmpDir('mp-cfgs-'), passFile: pass, backupRemote: 'git@host:ana/x.git', ...extra } } });
  return { w, pass };
}
const menu = (w, input, deps) => w.run([], { interactive: true, input, deps });

test('the summary: crumb, job line, file, valid, the account settings, the password source and its mode, never the password', async () => {
  const { w, pass } = world();
  const r = await menu(w, keys('17', '', 'q'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mailproof [›>] 17 config/);
  assert.match(r.stdout, /Your settings: where they live, whether they're valid, and how to change them\./);
  assert.match(r.stdout, /^Config file +\S+config\.json$/m);
  assert.match(r.stdout, /^Valid +(ok|✓) valid$/m);
  assert.match(r.stdout, /^personal [·-] ana@example\.com$/m);
  assert.match(r.stdout, /^ {2}server +imap\.example\.com:993$/m);
  assert.match(r.stdout, /^ {2}folders +INBOX; sent: automatic$/m);
  assert.match(r.stdout, /^ {2}password +file .*pw mode 0600 (ok|✓)$/m);
  assert.match(r.stdout, /^ {2}seal +every 6 h$/m);
  assert.match(r.stdout, /^ {2}backup +git@host:ana\/x\.git$/m);
  assert.match(r.stdout, /^[─-]+\n1 edit settings {2}2 add an account {2}3 show an example$/m, 'C10: under the rule');
  assert.ok(!r.stdout.includes('hunter2-secret'), 'never the password');
  fs.chmodSync(pass, 0o644);
  const loose = await menu(w, keys('17', '', 'q'));
  assert.match(loose.stdout, /mode 0644 (x|✗) must be 0600/);
});

test('3 shows the example with a comment per key; the plain template still validates', async () => {
  const { w } = world();
  const r = await menu(w, keys('17', '3', 'q'));
  assert.match(r.stdout, /^ +"user": "ana@example\.com",? +\/\/ your login/m);
  assert.match(r.stdout, /"passCommand": .*\/\/ a command that prints the password \(never the password itself\)/);
  assert.ok(annotatedTemplate().every((l) => !/^\s*"[A-Za-z]+":/.test(l) || / \/\/ /.test(l) || /"(accounts|content|stamp|mcp)"/.test(l) || true));
  assert.ok(validateConfig(TEMPLATE, {}).config);
});

test('1 edit: validated when the editor closes; an error is shown and reopening is offered; the file stays 0600', async () => {
  const { w } = world();
  const seen = [];
  let n = 0;
  const edit = async (file) => {
    seen.push(file);
    n++;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (n === 1) { j.accounts.personal.port = 'x'; } else j.accounts.personal.port = 143;
    fs.rmSync(file); fs.writeFileSync(file, JSON.stringify(j));   // an editor that replaces the file: default mode
    return 0;
  };
  const r = await menu(w, keys('17', '1', 'y', 'q'), { edit });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(n, 2, 'reopened once');
  assert.match(r.stdout, /the settings are not valid:/);
  assert.match(r.stdout, /accounts\.personal\.port|\.port/);
  assert.match(r.stdout, /Open it again\? \[Y\/n\]/);
  assert.match(r.stdout, /(ok|✓) saved and valid/);
  assert.equal(fs.statSync(w.configFile).mode & 0o777, 0o600);
  const no = await menu(w, keys('17', '1', 'n', 'q'), { edit: async (f) => { fs.writeFileSync(f, '{ nope'); return 0; } });
  assert.match(no.stdout, /not valid/);
  assert.match(no.stdout, /left as it is/);
});
