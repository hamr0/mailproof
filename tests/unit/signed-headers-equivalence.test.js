// The linear selectSigned / dropExtraSignatures must give EXACTLY the output of the
// earlier quadratic versions. The old implementations live here, in the test only, as
// the oracle; several hundred seeded inputs are compared for identical output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage, selectSigned, dropExtraSignatures } from '../../src/proof/signed-headers.js';

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

function oldDropExtraSignatures(buf, max) {
  const s = buf.toString('binary');
  const sep = /\r?\n\r?\n/.exec(s);
  const headEnd = sep ? sep.index : s.length;
  const lastEnd = sep ? headEnd + (sep[0][0] === '\r' ? 2 : 1) : s.length;
  const cut = [];
  let seen = 0;
  let start = -1;
  let isSig = false;
  const flush = (end) => { if (start >= 0 && isSig && seen > max) cut.push([start, end]); };
  for (let pos = 0; pos < headEnd; ) {
    const c = s.charCodeAt(pos);
    if (start < 0 || !(c === 32 || c === 9)) {
      flush(pos);
      start = pos;
      const colon = s.indexOf(':', pos);
      const eol = s.indexOf('\n', pos);
      isSig = colon > pos && (eol === -1 || colon < eol) && s.slice(pos, colon).trim().toLowerCase() === 'dkim-signature';
      if (isSig) seen++;
    }
    const nl = s.indexOf('\n', pos);
    if (nl === -1 || nl >= headEnd) break;
    pos = nl + 1;
  }
  flush(lastEnd);
  if (!cut.length) return buf;
  let out = '';
  let from = 0;
  for (const [a, b] of cut) { out += s.slice(from, a); from = b; }
  return Buffer.from(out + s.slice(from), 'binary');
}

// ---- seeded generator (mulberry32) ----
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

test('dropExtraSignatures: identical to the quadratic version over 600 generated inputs', () => {
  const r = rng(2);
  let cutCases = 0;
  for (let k = 0; k < 600; k++) {
    const lines = [];
    for (let i = 0, n = Math.floor(r() * 30); i < n; i++) {
      const kind = r();
      if (kind < 0.3) lines.push(`${CASES(r, 'dkim-signature')}: v=1; d=d${i}.example; b=AA`);
      else if (kind < 0.4) lines.push(pick(r, ['nocolonline', 'DKIM-Signature', 'dkim-signature  ', '']));   // colon-less, even a bare name
      else if (kind < 0.55 && lines.length) lines.push(pick(r, [' ', '\t', '  \t']) + `fold ${i}; b=x`);       // deep folding
      else if (kind < 0.62) lines.push(': empty name');
      else lines.push(`${CASES(r, pick(r, NAMES))}: v${i}`);
    }
    const eol = pick(r, ['\r\n', '\n']);
    const tail = pick(r, [eol + eol + 'body' + eol, eol + eol, '', eol, eol + eol + 'x']);   // no separator, no body, ...
    const text = lines.join(eol) + tail;
    const buf = Buffer.from(text, 'binary');
    const max = Math.floor(r() * 5);
    const a = dropExtraSignatures(buf, max);
    const b = oldDropExtraSignatures(buf, max);
    assert.ok(a.equals(b), `case ${k} max=${max}: ${JSON.stringify(text)}`);
    assert.equal(a === buf, b === buf, `case ${k}: same-buffer behaviour`);
    if (b !== buf) cutCases++;
  }
  assert.ok(cutCases > 50, `only ${cutCases} cases exercised a cut`);
});
