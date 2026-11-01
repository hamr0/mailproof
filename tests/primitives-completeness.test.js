// Completeness guard for primitives.json (pattern from the bare suite). A
// primitive is any export, or documented method of an exported class, whose
// JSDoc carries @when. This fails if a PUBLIC export is neither in
// primitives.json nor on the exclusion list below, so a new export can never
// silently miss the agent menu. `npm run check:primitives` (CI) covers the
// third way the manifest can be wrong: the committed file drifting from source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync(new URL('../primitives.json', import.meta.url), 'utf8'));
const manifested = new Set(manifest.primitives.map((p) => p.name));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Every public JS entry point, derived from package.json "exports" and resolved
// through the package NAME (Node self-reference), exactly what a consumer hits.
const SPECIFIERS = Object.entries(pkg.exports)
  .filter(([, entry]) => !(typeof entry === 'string' && entry.endsWith('.json')))
  .map(([sub]) => (sub === '.' ? pkg.name : `${pkg.name}/${sub.slice(2)}`));

// Deliberate exclusions, WHY each is out:
const EXCLUDED = new Set([
  // Constants a caller reads, not capabilities an agent reaches for.
  'TRUST_LEVELS', 'RULES_VERSION',
]);

async function allExports() {
  const names = new Set();
  for (const spec of SPECIFIERS) for (const n of Object.keys(await import(spec))) if (n !== 'default') names.add(n);
  return names;
}

test('every package.json export subpath resolves', async () => {
  assert.ok(SPECIFIERS.includes(pkg.name), "exports map has no '.' entry");
  for (const spec of SPECIFIERS) await assert.doesNotReject(import(spec), `export subpath does not resolve: ${spec}`);
  for (const [sub, entry] of Object.entries(pkg.exports)) {
    if (typeof entry === 'string' && entry.endsWith('.json')) {
      assert.ok(existsSync(new URL(`../${entry.slice(2)}`, import.meta.url)), `data export ${sub} points at a missing file`);
    }
  }
});

test('primitives.json is reachable through the published subpath', () => {
  assert.equal(pkg.exports['./primitives.json'], './primitives.json');
  const loaded = createRequire(import.meta.url)('mailproof/primitives.json');
  assert.deepEqual(Object.keys(loaded).sort(), ['package', 'primitives']);
  assert.equal(loaded.package, 'mailproof');
});

test('every public export is manifested or explicitly excluded', async () => {
  const missing = [...(await allExports())].filter((n) => !manifested.has(n) && !EXCLUDED.has(n)).sort();
  assert.deepEqual(missing, [], `neither in primitives.json nor EXCLUDED:\n  ${missing.join('\n  ')}`);
});

test('exclusion list has no stale entries', async () => {
  const exported = await allExports();
  const stale = [...EXCLUDED].filter((n) => manifested.has(n) || !exported.has(n)).sort();
  assert.deepEqual(stale, []);
});

test('manifest includes every Mailproof method (a dropped @when would silently drop it)', () => {
  const required = ['check', 'record', 'verify', 'matchBody', 'matchFile', 'copies', 'list', 'get'].map((m) => `Mailproof#${m}`);
  assert.deepEqual(required.filter((n) => !manifested.has(n)), []);
});

test('manifest is well-formed and carries no version', () => {
  assert.ok(manifest.primitives.length > 0);
  for (const p of manifest.primitives) {
    for (const f of ['name', 'category', 'when', 'import', 'signature', 'fails', 'example']) {
      assert.ok(p[f] && String(p[f]).trim(), `primitive ${p.name || '(unnamed)'} missing field: ${f}`);
    }
  }
  assert.equal(manifest.version, undefined);
});

test('every example is syntactically valid JavaScript', () => {
  for (const p of manifest.primitives) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--input-type=module', '--check'], { input: p.example, stdio: ['pipe', 'ignore', 'pipe'] }),
      `primitive ${p.name}: @example does not parse`,
    );
  }
});
