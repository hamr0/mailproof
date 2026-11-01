// COMPLEXITY GUARD: no public path may take time super-linear in the size of a sender-controlled input,
// and nothing the admission gate lets through may be expensive.
//
// Three layers (src/proof/admit.js is the gate; every bound is in src/proof/limits.js):
//   1. Growth. Each adversarial generator is grown to N and 2N and every public entry point is timed on both.
//      A generator whose base size N is now over a limit is run twice: at a size that FITS under the limit
//      (doubling still inside it, so the code behind the gate is what is timed) and at its original,
//      over-limit size (the gate refuses it; `gate` names the limit, and the refusal must be cheap).
//   2. The gate itself. admit() is timed on the shapes that force it to read every byte (one huge body line,
//      newlines, short lines): linear up to the 25 MiB total.
//   3. Ceilings. For every limit, the most expensive message that is still admitted (tests/helpers/worst-cases.js,
//      built just under the limit, 10 tampered signatures included) is checked with the real check() and must stay
//      under an absolute CPU ceiling, whatever the ratio. Size cases are linear in the message size, so their
//      ceiling is the cost of the 25 MiB the limit allows.
//
// The ratio method (layer 1):
// Method. For each adversarial generator (one input a sender controls, grown to size N and 2N) and each
// public entry point that reads it, time the call and assert
//     t(2N) < RATIO x t(N) + SLACK_MS      (linear code gives ~2x; a quadratic one gives ~4x)
//     t(2N) < CEILING_MS                   (an absolute bound, whatever the ratio)
// Timing is made stable by: measuring CPU time (process.cpuUsage), not wall clock, so a busy machine does
// not move the numbers; one untimed warm-up call at each size (JIT, module load, first git/process
// spawn), then the MEDIAN of 3 timed runs; the generators are sized so linear code stays well under a
// second, while the quadratic code they were written to catch takes several seconds. The ratio has
// slack for the fixed cost (process spawn, git) and for CPU noise from parallel test files; a pair that
// fails is measured once more and only a second failure counts (see `judge`).
//
// Entry points: check, record (a repeat of the same bytes: the build, lock and duplicate check run, the
// commit does not), verifyRecord, matchBody, matchFile, and the OTS `ots info` parser (through
// createOts with a fake binary); list/copies are timed on trails of K and 2K records. A message the
// decoder rejects on purpose (header block over 1 MiB, EMAXLEN) is timed to its rejection.
// Set COMPLEXITY_REPORT=1 to print the table of measured times.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Mailproof, verifyRecord } from '../../src/index.js';
import { createOts } from '../../src/proof/ots.js';
import { admit } from '../../src/proof/admit.js';
import { MAX_TOTAL_BYTES } from '../../src/proof/limits.js';
import { makeKey, signedMail } from '../helpers/proof.js';
import { WORST_CASES, admitted } from '../helpers/worst-cases.js';

const RATIO = 3;
const SLACK_MS = 100;
const CEILING_MS = 2500;
const RUNS = 3;
const REPORT = Boolean(process.env.COMPLEXITY_REPORT);

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp-cx-'));
const nxdomain = async () => { throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' }); };
const CRLF = '\r\n';
const SIG = (extra = '') => `DKIM-Signature: v=1; a=rsa-sha256; d=x.example; s=sel; c=relaxed/relaxed; h=from; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA${extra}`;
/** headers (array of lines) + body -> Buffer */
const msg = (headers, body = 'hello' + CRLF) => Buffer.from([...headers, '', body].join(CRLF));

/**
 * Each generator: `build(n)` -> the raw message; `n` is its size knob. `N` is the base size, 2N the
 * doubled one. `gate`: the limit that refuses the message at 2N (absent when 2N is admitted); `fit`: a base size
 * whose doubling is still admitted (present exactly when `gate` is). `init()` (optional, async) returns
 * `{ resolver, build }` for a generator that needs a signature DNS can vouch for.
 */
const GENERATORS = {
  'whitespace runs in the body': {
    N: 20000,
    // one body line: a long run of spaces that does not end the line; relaxed + a wrong bh= sends it down the mismatch search
    build: (n) => msg([SIG(), 'From: me@x.example'], 'a' + ' '.repeat(n) + 'b' + CRLF),
  },
  'no-@ From (signed)': {
    // needs a signature that VERIFIES: the From domain is only read for alignment once a signature holds
    N: 10000,
    init: async () => {
      const key = makeKey('rsa');
      const mk = (n) => signedMail({ from: 'a'.repeat(n), signers: [{ domain: 'signer.example', selector: 'sel1', key }] });
      const first = await mk(1);
      return { resolver: first.resolver, build: async (n) => (await mk(n)).raw };
    },
  },
  '< runs in List-Id': {
    N: 15000,
    build: (n) => msg([SIG(), 'From: me@x.example', `List-Id: ${'<'.repeat(n)}`], 'x' + CRLF),
  },
  'colon-less header lines': {
    gate: 'header_fields', fit: 400,
    // 64-char lines: the decoder charges at least 64 bytes a line, so 15000 is just under its 1 MiB cap.
    // The body has no colon either, so a colon search that is not bounded to its line runs to the end of the message.
    // The signed bh= matches the body, so the body costs one hash and the header scan is what is left to time.
    N: 7500,
    build: (n) => {
      const body = ('x'.repeat(79) + CRLF).repeat(Math.ceil(n * 150 / 81));   // short lines: one very long line is slow inside mailauth's relaxed body canonicaliser (reported separately)
      const bh = crypto.createHash('sha256').update(body).digest('base64');
      return msg([SIG().replace(/bh=[^;]*/, `bh=${bh}`), 'From: me@x.example', ...Array.from({ length: n }, () => 'A'.repeat(64))], body);
    },
  },
  'colon-less header lines (rejected size)': {
    N: 60000, gate: 'header_fields', fit: 0,
    build: (n) => msg([SIG(), 'From: me@x.example', ...Array.from({ length: n }, () => 'A')]),
  },
  'huge h=': {
    N: 50000, gate: 'h_names', fit: 90,
    build: (n) => msg([SIG().replace('h=from', `h=${Array.from({ length: n }, () => 'a').join(':')}`), 'From: me@x.example', ...Array.from({ length: 900 }, () => 'A: v')]),
  },
  'many repeated header names': {
    N: 7500, gate: 'header_fields', fit: 450,
    build: (n) => msg([SIG().replace('h=from', 'h=received:received:received'), 'From: me@x.example', ...Array.from({ length: n }, (_, i) => `Received: hop ${i}`)]),
  },
  'many DKIM-Signatures': {
    N: 4000, gate: 'signatures', fit: 5,
    build: (n) => msg([...Array.from({ length: n }, (_, i) => `DKIM-Signature: v=1; d=d${i}.x; s=s; h=from; bh=AA; b=AA`), 'From: me@x.example']),
  },
  'deep folding': {
    N: 7500, gate: 'header_lines', fit: 1900,
    build: (n) => msg([SIG().replace('h=from', 'h=subject'), 'From: me@x.example', 'Subject: s' + Array.from({ length: n }, () => `${CRLF} folded`).join('')]),
  },
  'long bh=/b= tag values': {
    N: 30000, gate: 'sig_bytes', fit: 1800,
    build: (n) => msg([SIG().replace('bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `bh=${'A '.repeat(n)}`).replace('b=AAAA', `b=${'A '.repeat(n)}`), 'From: me@x.example']),
  },
  'many MIME parts / attachments': {
    N: 150, gate: 'mime_parts', fit: 90,
    build: (n) => {
      const parts = Array.from({ length: n }, (_, i) => `--bnd${CRLF}Content-Type: application/octet-stream; name="f${i}.bin"${CRLF}Content-Disposition: attachment; filename="f${i}.bin"${CRLF}${CRLF}data${i}${CRLF}`).join('');
      return msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], parts + `--bnd--${CRLF}`);
    },
  },
  'many message/rfc822 parts': {
    N: 150, gate: 'mime_parts', fit: 90,
    build: (n) => {
      const part = `--bnd${CRLF}Content-Type: message/rfc822${CRLF}${CRLF}From: a@b.example${CRLF}Subject: inner${CRLF}${CRLF}inner body${CRLF}`;
      return msg([SIG(), 'From: me@x.example', 'Subject: Fwd: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], part.repeat(n) + `--bnd--${CRLF}`);
    },
  },
};

function median(xs) { return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]; }

/**
 * Warm up once, then the median of RUNS timed runs of `fn`, in ms of CPU time (user + system of this
 * process, not wall clock): other processes competing for the machine stretch wall time but not the
 * CPU a call itself burns, which is what grows with the input.
 */
async function time(fn) {
  await fn();
  const ts = [];
  for (let i = 0; i < RUNS; i++) {
    const c0 = process.cpuUsage();
    await fn();
    const c = process.cpuUsage(c0);
    ts.push((c.user + c.system) / 1000);
  }
  return median(ts);
}

const settle = async (p) => { try { await p; } catch { /* a rejection is a result: its time is what is measured */ } };

const ok = (t1, t2) => t2 < RATIO * t1 + SLACK_MS && t2 < CEILING_MS;

/**
 * Time `run1` (size N) and `run2` (size 2N) and judge the pair. A pair that fails is measured ONCE more
 * and only a second failure counts: parallel test files make a single measurement noisy, while code
 * that is really super-linear fails every measurement.
 */
async function judge(label, run1, run2) {
  let t1 = await time(run1), t2 = await time(run2);
  const first = [t1, t2];
  if (!ok(t1, t2)) { t1 = await time(run1); t2 = await time(run2); }
  if (REPORT) console.log(`${label.padEnd(66)} t(N)=${t1.toFixed(1).padStart(8)} ms  t(2N)=${t2.toFixed(1).padStart(8)} ms  x${(t2 / Math.max(t1, 0.01)).toFixed(2)}${first[0] === t1 ? '' : '  (re-measured)'}`);
  assert.ok(t2 < RATIO * t1 + SLACK_MS, `${label}: t(N)=${t1.toFixed(1)} ms, t(2N)=${t2.toFixed(1)} ms (first try ${first.map((x) => x.toFixed(1)).join(' / ')}): grew more than ${RATIO}x + ${SLACK_MS} ms when the input doubled`);
  assert.ok(t2 < CEILING_MS, `${label}: t(2N)=${t2.toFixed(1)} ms is over the ${CEILING_MS} ms ceiling`);
}

/** Time every public entry point on `base` and `2 * base` of a generator; `offline`: also the ones that read a stored record. */
async function growth(name, g, base, { offline }) {
  const { resolver, build } = g.init ? await g.init() : { resolver: nxdomain, build: g.build };
  const mp = new Mailproof({ trailDir: dir(), resolver });
  const sizes = [];
  for (const n of [base, 2 * base]) sizes.push({ n, raw: await build(n) });
  if (offline) {
    for (const s of sizes) {
      assert.equal(admit(s.raw).limit, null, `${name} at ${s.n} must be admitted: the code behind the gate is what is timed here`);
      s.rec = await mp.get((await mp.record(s.raw, { direction: 'in', source: 'cx' })).id);
    }
  }
  const entries = {
    check: (s) => settle(mp.check(s.raw)),
    record: (s) => settle(mp.record(s.raw, { direction: 'in', source: 'cx' })),
    ...(offline ? {
      verifyRecord: (s) => verifyRecord(s.rec),
      matchBody: (s) => mp.matchBody(s.rec, s.raw),
      matchFile: (s) => mp.matchFile(s.rec, Buffer.from('some file bytes')),
    } : {}),
  };
  for (const [entry, run] of Object.entries(entries)) {
    await judge(`${name} :: ${entry}`, () => run(sizes[0]), () => run(sizes[1]));
  }
  return build;
}

for (const [name, g] of Object.entries(GENERATORS)) {
  if (g.fit !== 0) {
    test(`complexity: ${name}`, async () => {
      await growth(name, g, g.fit ?? g.N, { offline: true });
    });
  }
  if (g.gate) {
    test(`complexity: ${name} (original size: refused by the gate)`, async () => {
      const build = await growth(name, g, g.N, { offline: false });
      assert.equal(admit(await build(2 * g.N)).limit, g.gate, 'the limit that refuses the doubled message');
    });
  }
}

// ---- layer 2: the gate reads every byte once -------------------------------------------------------------
// Shapes that make admit() scan the whole message before it decides (a refusal for a long line can only come at
// the end of the line). Sizes go up to the total the gate allows.
const MiB = 1 << 20;
const GATE_SHAPES = {
  'one body line': (n) => Buffer.concat([Buffer.from('A: 1\r\n\r\n'), Buffer.alloc(n, 0x61)]),
  'body of newlines': (n) => Buffer.concat([Buffer.from('A: 1\r\n\r\n'), Buffer.alloc(n, 0x0a)]),
  'body of CRLFs': (n) => Buffer.concat([Buffer.from('A: 1\r\n\r\n'), Buffer.from('\r\n'.repeat(n / 2))]),
  'one-byte lines': (n) => Buffer.concat([Buffer.from('A: 1\r\n\r\n'), Buffer.from('a\n'.repeat(n / 2))]),
  'ordinary 76-column lines': (n) => Buffer.concat([Buffer.from('A: 1\r\n\r\n'), Buffer.from(('a'.repeat(76) + '\r\n').repeat(Math.floor(n / 78)))]),
  'lines of 33 bytes (just past the short-line window)': (n) => Buffer.concat([Buffer.from('A: 1\r\n\r\n'), Buffer.from(('a'.repeat(32) + '\n').repeat(Math.floor(n / 33)))]),
};
for (const [name, mk] of Object.entries(GATE_SHAPES)) {
  test(`complexity: admit() on ${name}`, async () => {
    const [a, b] = [mk(6 * MiB), mk(12 * MiB)];
    await judge(`admit :: ${name}`, () => admit(a), () => admit(b));
    assert.ok(admit(mk(24 * MiB)).m.bytes <= MAX_TOTAL_BYTES);
  });
}

// ---- layer 3: ceilings on what is admitted ---------------------------------------------------------------
// Measured on an idle machine every case below the size cases is under 0.55 s (the 10 tampered signatures: 0.1-0.5 s;
// before the per-message budget: 2.8-7.9 s). The ceiling is 2 s because CPU time itself stretches ~2x when the whole
// suite runs its files in parallel; that still separates the two by a wide margin. Size cases: ~75 ms a MiB, linear.
const CEILING_DEFAULT_MS = 2000;
/** CPU ms of one call after one warm-up call; the best of `runs` (a ceiling asks "can it be fast?", noise only ever adds). */
async function bestOf(fn, { runs, warm }) {
  if (warm) await fn();
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const c0 = process.cpuUsage();
    await fn();
    const c = process.cpuUsage(c0);
    best = Math.min(best, (c.user + c.system) / 1000);
  }
  return best;
}
for (const c of WORST_CASES) {
  test(`ceiling: ${c.limit}: ${c.name}`, async () => {
    const ceiling = c.ceilingMs ?? CEILING_DEFAULT_MS;
    const { raw, resolver } = await c.build();
    admitted(raw);
    const mp = new Mailproof({ trailDir: dir(), resolver: resolver || nxdomain });
    const big = ceiling > CEILING_DEFAULT_MS;   // size cases: seconds each, so no warm-up and a single run
    const ms = await bestOf(() => settle(mp.check(raw)), { runs: big ? 1 : 2, warm: !big });
    if (REPORT) console.log(`${('ceiling: ' + c.limit + ': ' + c.name).padEnd(100)} ${ms.toFixed(0).padStart(6)} ms (ceiling ${ceiling})`);
    assert.ok(ms < ceiling, `${c.name}: ${ms.toFixed(0)} ms of CPU for one check(), over the ${ceiling} ms ceiling${c.why ? ` (${c.why})` : ''}`);
  });
}

test('complexity: OTS-style attestation blob (ots info parser)', async () => {
  const N = 3000;
  const mk = async (n) => {
    const d = dir();
    const blob = path.join(d, 'blob.txt');
    // attestation nodes, none followed by a block-height-like digit run: every node would rescan to the end
    fs.writeFileSync(blob, Array.from({ length: n }, (_, i) => `BitcoinBlockHeaderAttestation(x${i})`).join('\n'));
    const bin = path.join(d, 'ots');
    fs.writeFileSync(bin, `#!/bin/sh\ncat '${blob}'\n`, { mode: 0o755 });
    return () => createOts({ otsBin: bin, timeoutMs: 20000 }).readBlockHeight(path.join(d, 'x.ots'));
  };
  const a = await mk(N), b = await mk(2 * N);
  assert.equal(await a(), null);
  await judge('OTS-style attestation blob :: readBlockHeight', a, b);
});

test('complexity: list / copies read a trail in time linear in its records', async () => {
  const K = 30;
  const mkTrail = async (k) => {
    const mp = new Mailproof({ trailDir: dir(), resolver: nxdomain });
    let first = null;
    for (let i = 0; i < k; i++) {
      const r = await mp.record(msg([SIG(), 'From: me@x.example', `Message-ID: <m${i}@x.example>`], `body ${i}` + CRLF), { direction: 'in', source: 'cx' });
      first = first || r.id;
    }
    return { mp, first };
  };
  const a = await mkTrail(K), b = await mkTrail(2 * K);
  await judge('trail of K vs 2K records :: list', () => a.mp.list(), () => b.mp.list());
  await judge('trail of K vs 2K records :: copies', () => a.mp.copies(a.first), () => b.mp.copies(b.first));
});
