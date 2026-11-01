// The linear selectSigned must give EXACTLY the output of the earlier quadratic version. The
// old implementation lives here, in the test only, as the oracle; several hundred seeded
// inputs are compared for identical output. (dropExtraSignatures, which had the same test,
// is gone: the admission gate refuses a message with more than 10 signatures instead.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, selectSigned } from '../../src/proof/signed-headers.js';

// ---- the oracle: the implementations as they were before the linear rewrite ----
function oldSelectSigned(rows, h) {
  const used = new Map();
  const out = [];
  for (const nm of h.split(':').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const idxs = rows.map((r, i) => (r.name === nm ? i : -1)).filter((i) => i >= 0);
    const n = used.get(nm) || 0;
    if (n < idxs.length) {
      out.push(rows[idxs[idxs.length - 1 - n]].raw);
      used.set(nm, n + 1);
    }
  }
  return out;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, a) => a[Math.floor(r() * a.length)];

const NAMES = ['from', 'to', 'received', 'subject', 'dkim-signature', 'x-a', 'cc'];
const CASES = (r, n) => pick(r, [n, n.toUpperCase(), n[0].toUpperCase() + n.slice(1), ` ${n} `, `${n} `]);

test('selectSigned: identical to the quadratic version over 400 generated inputs', () => {
  const r = rng(1);
  for (let k = 0; k < 400; k++) {
    const nl = pick(r, ['\r\n', '\n']);
    const lines = [];
    for (let i = 0, n = Math.floor(r() * 25); i < n; i++) {
      const kind = r();
      if (kind < 0.12) lines.push(pick(r, ['nocolonline', ': leading colon', '']));        // missing colon / empty
      else if (kind < 0.25 && lines.length) lines.push(pick(r, [' ', '\t']) + 'folded ' + i); // folded continuation
      else lines.push(`${CASES(r, pick(r, NAMES))}: v${i}`);
    }
    const msg = lines.join(nl) + nl + nl + 'body';
    const { rows } = splitMessage(msg);
    const hNames = [];
    for (let i = 0, n = Math.floor(r() * 20); i < n; i++) hNames.push(r() < 0.1 ? '' : CASES(r, pick(r, [...NAMES, 'absent', 'oversigned'])));
    const h = hNames.join(':');
    assert.deepEqual(selectSigned(rows, h), oldSelectSigned(rows, h), `case ${k}: h=${JSON.stringify(h)}`);
  }
  assert.deepEqual(selectSigned([], 'a:b'), []);
  assert.deepEqual(selectSigned([{ name: 'a', raw: 'A: 1' }], ''), []);
});
