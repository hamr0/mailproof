// COMPLEXITY GUARD: no public path may take time super-linear in the size of a sender-controlled input.
//
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
import { makeKey, signedMail } from '../helpers/proof.js';

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
 * doubled one. `rejected`: the decoder rejects the message. `init()` (optional, async) returns
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
    N: 60000, rejected: true,
    build: (n) => msg([SIG(), 'From: me@x.example', ...Array.from({ length: n }, () => 'A')]),
  },
  'huge h=': {
    N: 50000,
    build: (n) => msg([SIG().replace('h=from', `h=${Array.from({ length: n }, () => 'a').join(':')}`), 'From: me@x.example', ...Array.from({ length: 900 }, () => 'A: v')]),
  },
  'many repeated header names': {
    N: 7500,
    build: (n) => msg([SIG().replace('h=from', 'h=received:received:received'), 'From: me@x.example', ...Array.from({ length: n }, (_, i) => `Received: hop ${i}`)]),
  },
  'many DKIM-Signatures': {
    N: 4000,
    build: (n) => msg([...Array.from({ length: n }, (_, i) => `DKIM-Signature: v=1; d=d${i}.x; s=s; h=from; bh=AA; b=AA`), 'From: me@x.example']),
  },
  'deep folding': {
    N: 7500,
    build: (n) => msg([SIG().replace('h=from', 'h=subject'), 'From: me@x.example', 'Subject: s' + Array.from({ length: n }, () => `${CRLF} folded`).join('')]),
  },
  'long bh=/b= tag values': {
    N: 30000,
    build: (n) => msg([SIG().replace('bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', `bh=${'A '.repeat(n)}`).replace('b=AAAA', `b=${'A '.repeat(n)}`), 'From: me@x.example']),
  },
  'many MIME parts / attachments': {
    N: 150,
    build: (n) => {
      const parts = Array.from({ length: n }, (_, i) => `--bnd${CRLF}Content-Type: application/octet-stream; name="f${i}.bin"${CRLF}Content-Disposition: attachment; filename="f${i}.bin"${CRLF}${CRLF}data${i}${CRLF}`).join('');
      return msg([SIG(), 'From: me@x.example', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="bnd"'], parts + `--bnd--${CRLF}`);
    },
  },
  'many message/rfc822 parts': {
    N: 150,
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

for (const [name, g] of Object.entries(GENERATORS)) {
  test(`complexity: ${name}`, async () => {
    const { resolver, build } = g.init ? await g.init() : { resolver: nxdomain, build: g.build };
    const mp = new Mailproof({ trailDir: dir(), resolver });
    const sizes = [];
    for (const n of [g.N, 2 * g.N]) sizes.push({ n, raw: await build(n) });
    // stored records for the offline entry points (not available when the decoder rejects the message)
    for (const s of sizes) {
      if (g.rejected) { s.rec = null; continue; }
      const r = await mp.record(s.raw, { direction: 'in', source: 'cx' });
      s.rec = await mp.get(r.id);
    }
    const entries = {
      check: (s) => settle(mp.check(s.raw)),
      record: (s) => settle(mp.record(s.raw, { direction: 'in', source: 'cx' })),
      ...(g.rejected ? {} : {
        verifyRecord: (s) => verifyRecord(s.rec),
        matchBody: (s) => mp.matchBody(s.rec, s.raw),
        matchFile: (s) => mp.matchFile(s.rec, Buffer.from('some file bytes')),
      }),
    };
    for (const [entry, run] of Object.entries(entries)) {
      await judge(`${name} :: ${entry}`, () => run(sizes[0]), () => run(sizes[1]));
    }
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
