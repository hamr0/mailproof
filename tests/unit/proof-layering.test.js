// src/proof/* is the v2 layer: it must never import a v1 module.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../../src/proof/', import.meta.url);

test('src/proof never imports outside src/proof', () => {
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/g)) {
      if (m[1].startsWith('../')) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});
