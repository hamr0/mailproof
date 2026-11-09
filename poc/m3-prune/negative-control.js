// Can the checker fail? Build a pruned trail with option B on a small synthetic trail, then damage it five ways and require
// check.js to exit non-zero each time (and exit 0 on the undamaged one).  Usage: node negative-control.js <scratchDir>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sh, cutoffAtFraction } from './lib.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const scratch = process.argv[2];
const src = path.join(scratch, 'trail-300', 't');
if (!fs.existsSync(src)) execFileSync('node', [path.join(HERE, 'gen.js'), scratch, '300'], { stdio: 'ignore' });
const cutoff = cutoffAtFraction(src, 0.5);
const good = path.join(scratch, 'nc-good.git');
execFileSync('node', [path.join(HERE, 'b.js'), src, cutoff, good], { stdio: 'ignore' });
const check = (repo, c = cutoff) => spawnSync('node', [path.join(HERE, 'check.js'), src, c, repo], { encoding: 'utf8' });
const git = (cwd, args, env = {}, input) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, input }).toString().trim();
const out = [];
const rec = (name, r) => out.push({ case: name, exit: r.status, firstProblem: (JSON.parse(r.stdout || '{"problems":["(no output) " ]}').problems || [])[0] });
rec('undamaged (expect exit 0)', check(good));
const variant = (name, fn) => { const d = path.join(scratch, 'nc-' + name + '.git'); fs.rmSync(d, { recursive: true, force: true }); fs.cpSync(good, d, { recursive: true }); fn(d); return d; };
const rewriteHead = (d, mut) => { // rewrite the tip commit: mut({tree,msg,env}) -> new
  const head = git(d, ['rev-parse', 'HEAD']);
  const parent = git(d, ['rev-parse', 'HEAD^']);
  const raw = execFileSync('git', ['cat-file', 'commit', head], { cwd: d }).toString(); const body = raw.slice(raw.indexOf('\n\n') + 2);
  const env = { GIT_AUTHOR_NAME: git(d, ['log', '-1', '--format=%an']), GIT_AUTHOR_EMAIL: git(d, ['log', '-1', '--format=%ae']), GIT_AUTHOR_DATE: git(d, ['log', '-1', '--format=%ad', '--date=raw']), GIT_COMMITTER_NAME: git(d, ['log', '-1', '--format=%cn']), GIT_COMMITTER_EMAIL: git(d, ['log', '-1', '--format=%ce']), GIT_COMMITTER_DATE: git(d, ['log', '-1', '--format=%cd', '--date=raw']) };
  const r = mut({ tree: git(d, ['rev-parse', 'HEAD^{tree}']), msg: body, env });
  const n = git(d, ['commit-tree', r.tree, '-p', parent], r.env || env, r.msg);
  git(d, ['update-ref', 'refs/heads/main', n]);
};
rec('message of last commit changed', check(variant('msg', (d) => rewriteHead(d, (x) => ({ ...x, msg: 'tampered\n' })))));
rec('author date of last commit changed', check(variant('date', (d) => rewriteHead(d, (x) => ({ ...x, env: { ...x.env, GIT_AUTHOR_DATE: '1700000000 +0000' } })))));
rec('a pruned record file present in the final tree', check(variant('leak', (d) => {
  const oldFile = sh(src, ['ls-tree', '-r', 'HEAD~0', '--name-only']).split('\n').find((p) => p.startsWith('records/') && p.endsWith('.json'));
  const sha = execFileSync('git', ['--git-dir', d, 'hash-object', '-w', '--stdin'], { input: execFileSync('git', ['-C', src, 'cat-file', 'blob', 'HEAD:' + oldFile]) }).toString().trim();
  execFileSync('git', ['--git-dir', d, 'read-tree', 'HEAD'], { env: { ...process.env, GIT_INDEX_FILE: path.join(d, 'idx') } });
  execFileSync('git', ['--git-dir', d, 'update-index', '--add', '--cacheinfo', `100644,${sha},records/${'0'.repeat(32)}.json`], { env: { ...process.env, GIT_INDEX_FILE: path.join(d, 'idx') } });
  const tree = execFileSync('git', ['--git-dir', d, 'write-tree'], { env: { ...process.env, GIT_INDEX_FILE: path.join(d, 'idx') } }).toString().trim();
  rewriteHead(d, (x) => ({ ...x, tree }));
}))); // (a record file for an id the old trail never had: caught as a changed final tree)
rec('one blob byte changed in a kept record', check(variant('blob', (d) => {
  const p = sh(d, ['ls-tree', '-r', 'HEAD', '--name-only']).split('\n').filter((q) => q.startsWith('records/') && q.endsWith('.json')).pop();
  const bad = Buffer.from(execFileSync('git', ['-C', d, 'cat-file', 'blob', 'HEAD:' + p])); bad[bad.length - 3] ^= 1;
  const sha = execFileSync('git', ['--git-dir', d, 'hash-object', '-w', '--stdin'], { input: bad }).toString().trim();
  const env = { ...process.env, GIT_INDEX_FILE: path.join(d, 'idx') };
  execFileSync('git', ['--git-dir', d, 'read-tree', 'HEAD'], { env });
  execFileSync('git', ['--git-dir', d, 'update-index', '--cacheinfo', `100644,${sha},${p}`], { env });
  const tree = execFileSync('git', ['--git-dir', d, 'write-tree'], { env }).toString().trim();
  rewriteHead(d, (x) => ({ ...x, tree }));
})));
rec('wrong cutoff passed to the checker (notice mismatch)', check(good, new Date(Date.parse(cutoff) + 86400000 * 30).toISOString()));
console.log(JSON.stringify(out, null, 1));
for (const f of fs.readdirSync(scratch).filter((f) => f.startsWith('nc-'))) fs.rmSync(path.join(scratch, f), { recursive: true, force: true });
const ok = out[0].exit === 0 && out.slice(1).every((o) => o.exit !== 0);
console.log(ok ? 'NEGATIVE CONTROL OK: every damage was caught' : 'NEGATIVE CONTROL FAILED');
process.exit(ok ? 0 : 1);
