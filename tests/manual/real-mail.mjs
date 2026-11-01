// MANUAL real-mail check (never run in CI, never commits anything to the repo).
// Drives the public M0 API over a directory of real .eml files and prints, per
// DKIM signature: live vs offline agreement plus the F6 negative scenarios.
//
//   node tests/manual/real-mail.mjs <dir-of-.eml> [trailDir]
//
// The trail is written under trailDir (default: a fresh os.tmpdir() dir), so the
// samples and their records stay out of the repo. Output prints DOMAINS only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Mailproof, verifyRecord } from '../../src/index.js';

const dir = path.resolve((process.argv[2] || '').replace(/^~/, os.homedir()));
const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const trailDir = path.resolve(process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), 'mp-real-')));
if (!process.argv[2]) { console.error('usage: real-mail.mjs <dir-of-.eml> [trailDir]'); process.exit(2); }
if (trailDir.startsWith(repo + path.sep)) { console.error('refusing: trailDir is inside the repo'); process.exit(2); }

const b64 = (b) => Buffer.from(b).toString('base64');
const un = (x) => Buffer.from(x, 'base64').toString('binary');
const clone = (r) => structuredClone(r);
const fail = (rec, opts) => !verifyRecord(rec, opts).signatures[0]?.ok;   // signature 0 of a single-sig clone

function only(rec, i) { const r = clone(rec); r.signatures = [r.signatures[i]]; return r; }
function tamperA(r) { const s = r.signatures[0]; let i = s.signed_headers.findIndex((x) => /^(subject|from):/i.test(un(x))); if (i < 0) i = 0; const t = un(s.signed_headers[i]); const c = t.indexOf(':'); const j = c + 1 + t.slice(c + 1).search(/[A-Za-z0-9]/); s.signed_headers[i] = b64(Buffer.from(t.slice(0, j) + (t[j] === 'x' ? 'y' : 'x') + t.slice(j + 1), 'binary')); return r; }
function tamperB(r) { const k = r.signatures[0].key; if (k.k === 'ed25519') k.p = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'); else k.p = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'); return r; }
function tamperC(r) { r.signatures[0].signed_headers.splice(0, 1); return r; }
function tamperE(r) { const s = r.signatures[0]; s.dkim_signature = b64(Buffer.from(un(s.dkim_signature).replace(/(\bb=\s*)([A-Za-z0-9+/]{8})/, (m, a, f) => a + (f[0] === 'A' ? 'B' : 'A') + f.slice(1)), 'binary')); return r; }
function tamperF(r) { const h = r.signatures[0].signed_headers; let j = -1; for (let k = h.length - 1; k > 0; k--) if (h[k] !== h[0]) { j = k; break; } if (j < 0) return null; [h[0], h[j]] = [h[j], h[0]]; return r; }
function tamperX(r) { const s = r.signatures[0]; const sg = un(s.dkim_signature); if (!/\bx=\d+/.test(sg)) return null; s.dkim_signature = b64(Buffer.from(sg.replace(/\bx=(\d+)/, (m, d) => 'x=' + (Number(d) + 1)), 'binary')); return r; }

const mp = new Mailproof({ trailDir });
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.eml')).sort();
const items = [];
for (let n = 0; n < files.length; n++) {
  const raw = fs.readFileSync(path.join(dir, files[n]));
  const r = await mp.record(raw, { direction: 'in', source: 'manual' });
  const rec = r.record || await mp.get(r.id);
  items.push({ n: n + 1, raw, rec });
}

const rows = [];
let bad = 0;
const flag = (ok, label) => { if (!ok) bad++; return ok ? label : label + '!'; };
for (const it of items) {
  const { rec, raw, n } = it;
  const own = await mp.matchBody(rec, raw);
  const live = rec.verdicts.live.dkim;
  for (let i = 0; i < rec.signatures.length; i++) {
    const sg = rec.signatures[i];
    const one = only(rec, i);
    const lv = live.length === rec.signatures.length ? live[i] : live.find((x) => x.d === sg.tags.d && x.s === sg.tags.s);
    const off = verifyRecord(one).signatures[0];
    const bodyBad = !own.signatures[i].match;           // F4 class: body altered between sender and export
    const liveRes = lv ? lv.result : 'n/a';
    const agree = bodyBad ? 'n/a(body)' : (liveRes === 'pass') === off.ok ? 'yes' : 'NO';
    if (agree === 'NO') bad++;
    const t = {};
    t.a = flag(fail(tamperA(clone(one))), 'fail');
    t.b = flag(fail(tamperB(clone(one))), 'fail');
    t.c = flag(fail(tamperC(clone(one))), 'fail');
    t.e = flag(fail(tamperE(clone(one))), 'fail');
    const f = tamperF(clone(one)); t.f = f ? flag(fail(f), 'fail') : '-';
    const x = tamperX(clone(one)); t.x = x ? flag(fail(x), 'fail') : '-';
    const other = items.flatMap((o) => o.rec.signatures.map((s) => ({ s, d: s.tags.d }))).find((o) => o.d !== sg.tags.d && o.s.key && sg.key && o.s.key.p !== sg.key.p && o.s.key.k === sg.key.k);
    t.d = other ? flag(fail((() => { const r = clone(one); r.signatures[0].key = other.s.key; return r; })()), 'fail') : 'n/a';
    const swap = items.find((o) => o.n !== n && o.rec.signatures[0] && o.rec.signatures[0].tags.bh !== sg.tags.bh);
    t.g = (own.signatures[i].match ? 'own:ok' : 'own:no') + '/' + (swap ? ((await mp.matchBody(rec, swap.raw)).signatures[i].match ? flag(false, 'swap:PASS') : 'swap:fail') : 'n/a');
    const xs = Number(sg.tags.x), ts = Number(sg.tags.t);
    t.h = (sg.tags.x ? (() => { const r = verifyRecord(one, { at: (xs + 1) * 1000 }).signatures[0]; return flag(!r.ok && r.why === 'expired', 'exp:fail'); })() : 'exp:-') + '/' + (sg.tags.t ? flag(!verifyRecord(one, { at: (ts - 301) * 1000 }).signatures[0].ok, 'fut:fail') : 'fut:-');
    t.i = flag([undefined, null, '', 'not-a-date', 'garbage'].every((v) => { const r = clone(one); if (v === undefined) delete r.captured; else r.captured = v; return fail(r); }), 'fail');
    rows.push({ f: n, d: sg.tags.d, s: sg.tags.s, a: sg.tags.a, c: sg.tags.c, live: liveRes, off: off.ok ? 'pass' : `fail(${off.why})`, agree, partial: sg.partial_body ? 'l=' : '', ta: t.a, tb: t.b, tc: t.c, te: t.e, tf: t.f, tx: t.x, td: t.d, tg: t.g, th: t.h, ti: t.i });
  }
}
console.log(['file#', 'd=', 's=', 'a=', 'c=', 'live DKIM', 'offline@captured', 'agrees', 'l=', 'tamper a', 'b', 'c', 'e', 'f', 'x-edit', 'd key-replay', 'g body', 'h expired/future', 'i captured'].join(' | '));
for (const r of rows) console.log([r.f, r.d, r.s, r.a, r.c, r.live, r.off, r.agree, r.partial, r.ta, r.tb, r.tc, r.te, r.tf, r.tx, r.td, r.tg, r.th, r.ti].join(' | '));
console.log('\nBODY STATUS (per signature; kinds + counts/domains only)');
console.log('file# | d= | body | explain');
for (const it of items) for (const sg of it.rec.signatures) console.log([it.n, sg.tags.d, sg.body.status, sg.body.explain.map((e) => e.kind + (e.detail ? JSON.stringify(e.detail) : '')).join(' ') || '-'].join(' | '));
const bs = {}; for (const it of items) bs[it.rec.body_status] = (bs[it.rec.body_status] || 0) + 1;
console.log('record body_status:', JSON.stringify(bs));
const verdicts = items.map((it) => `${it.rec.verdicts.live.trust}/${it.rec.verdicts.portable.trust}`);
const tally = {}; for (const v of verdicts) tally[v] = (tally[v] || 0) + 1;
console.log('\nemails:', items.length, ' signatures:', rows.length, ' live/portable trust:', JSON.stringify(tally));
console.log('live-pass signatures:', rows.filter((r) => r.live === 'pass').length + '/' + rows.length, ' body-altered (n/a):', rows.filter((r) => r.agree === 'n/a(body)').length);
console.log('trail:', trailDir);
console.log(bad === 0 ? 'RESULT: OK (0 negatives passed, 0 disagreements)' : `RESULT: ${bad} PROBLEM(S) — marked with !`);
process.exit(bad === 0 ? 0 : 1);
