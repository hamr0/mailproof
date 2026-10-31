// M0 go/no-go POC (throwaway, never shipped): offline DKIM re-check from a stored
// signed-header record alone. Usage: node poc/m0-header-recheck.js <dir-of-.eml>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { authenticate } from 'mailauth';
import { generateCanonicalizedHeader } from 'mailauth/lib/dkim/header';
import { dkimBody } from 'mailauth/lib/dkim/body';

const OUT = '/tmp/claude-1000/-home-hamr-PycharmProjects-mailproof/0823cad8-7c59-4349-9c56-3ea2768689d2/scratchpad/m0';
const b64 = (b) => Buffer.from(b).toString('base64');

// ---- header block parsing (raw bytes kept as binary strings, folds preserved) ----
function splitMessage(buf) {
  const s = buf.toString('binary');
  const m = /\r?\n\r?\n/.exec(s);
  const head = m ? s.slice(0, m.index) : s;
  const body = m ? s.slice(m.index + m[0].length) : '';
  const rows = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && rows.length) rows[rows.length - 1] += '\r\n' + line;
    else rows.push(line);
  }
  return { rows: rows.map((r) => ({ name: r.slice(0, r.indexOf(':')).trim().toLowerCase(), raw: r })), body: Buffer.from(body, 'binary') };
}

function parseTags(raw) {
  const v = raw.slice(raw.indexOf(':') + 1);
  const t = {};
  for (const seg of v.split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    t[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).replace(/\s+/g, ' ').trim();
  }
  return t;
}
const canons = (c) => { const p = (c || 'simple/simple').split('/'); return { h: (p[0] || 'simple').toLowerCase(), b: (p[1] || 'simple').toLowerCase() }; };

// RFC 6376 5.4.2: each h= name takes next unused instance from the bottom; absent => nothing hashed
function selectSigned(rows, h) {
  const used = new Map();
  const out = [];
  for (const nm of h.split(':').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const idxs = rows.map((r, i) => (r.name === nm ? i : -1)).filter((i) => i >= 0);
    const n = used.get(nm) || 0;
    if (n < idxs.length) { out.push(rows[idxs[idxs.length - 1 - n]].raw); used.set(nm, n + 1); }
  }
  return out;
}

async function fetchKey(d, s) {
  const recs = await dns.resolveTxt(`${s}._domainkey.${d}`);
  const txt = recs.map((c) => c.join('')).find((r) => /(^|;)\s*p=/.test(r)) ?? recs[0].join('');
  const tags = parseTags('x:' + txt);
  return { k: (tags.k || 'rsa').toLowerCase(), p: (tags.p || '').replace(/\s+/g, ''), txt };
}

function buildRecord(rows, sigRow, key, ctx) {
  const tags = parseTags(sigRow.raw);
  return {
    v: 1, ...ctx,
    dkim_signature: b64(sigRow.raw === undefined ? '' : Buffer.from(sigRow.raw, 'binary')),
    tags: { d: tags.d, s: tags.s, a: tags.a, c: tags.c || 'simple/simple', h: tags.h, bh: tags.bh, l: tags.l, t: tags.t, x: tags.x },
    signed_headers: selectSigned(rows, tags.h || '').map((r) => b64(Buffer.from(r, 'binary'))),
    key: { k: key.k, p: key.p },
  };
}

function keyObject(k) {
  const der = Buffer.from(k.p, 'base64');
  if (k.k === 'ed25519') return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), der]), format: 'der', type: 'spki' });
  try { return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { return crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' }); }
}

// Offline re-check: ONLY the re-loaded JSON. No raw email, no DNS, no live mailauth call.
export function recheck(recordJson, opts = {}) {
  try {
    const rec = typeof recordJson === 'string' ? JSON.parse(recordJson) : recordJson;
    const sigRaw = Buffer.from(rec.dkim_signature, 'base64');
    const tags = parseTags(sigRaw.toString('binary'));
    const [alg, hash] = (tags.a || '').toLowerCase().split('-');
    if (hash !== 'sha256' || !['rsa', 'ed25519'].includes(alg)) return { ok: false, why: `unsupported a=${tags.a}` };
    const c = canons(tags.c);
    const lines = rec.signed_headers.map((x) => ({ line: Buffer.from(x, 'base64') }));
    const { canonicalizedHeader } = generateCanonicalizedHeader('DKIM', { headers: lines }, { signatureHeaderLine: sigRaw, canonicalization: `${c.h}/${c.b}` });
    const sig = Buffer.from((tags.b || '').replace(/\s+/g, ''), 'base64');
    const pub = keyObject(rec.key);
    const ok = alg === 'rsa'
      ? crypto.verify('sha256', canonicalizedHeader, pub, sig)
      : crypto.verify(null, crypto.createHash('sha256').update(canonicalizedHeader).digest(), pub, sig);
    const at = opts.at ?? Date.parse(rec.captured);
    const expires = tags.x ? Number(tags.x) : null;
    const expired_now = expires !== null && Date.now() / 1000 > expires;
    let why = ok ? '' : 'bad signature';
    let res = ok;
    if (ok && Number.isFinite(at)) {
      const atS = at / 1000;
      if (expires !== null && atS > expires) { res = false; why = 'expired'; }
      else if (tags.t && Number(tags.t) > atS + 300) { res = false; why = 'timestamp in future'; }
    } else if (ok) { res = false; why = 'no usable capture time'; }
    return { ok: res, why, expires, expired_now, canon: canonicalizedHeader };
  } catch (e) { return { ok: false, why: 'error: ' + e.message }; }
}

export function matchBody(rec, raw) {
  try { return bodyMatch(rec, splitMessage(Buffer.from(raw)).body); } catch { return false; }
}
function bodyMatch(rec, bodyBuf) {
  const t = rec.tags;
  const c = canons(t.c);
  const h = dkimBody(c.b, t.a.split('-').pop(), t.l ? Number(t.l) : false);
  h.update(bodyBuf);
  return h.digest('base64') === t.bh.replace(/\s+/g, '');
}

// ---- tamper helpers (operate on the parsed JSON record) ----
function tamperA(rec) {
  const r = structuredClone(rec);
  let i = r.signed_headers.findIndex((x) => /^(subject|from):/i.test(Buffer.from(x, 'base64').toString('binary')));
  if (i < 0) i = 0;
  const s = Buffer.from(r.signed_headers[i], 'base64').toString('binary');
  const colon = s.indexOf(':');
  const j = colon + 1 + s.slice(colon + 1).search(/[A-Za-z0-9]/);
  r.signed_headers[i] = b64(Buffer.from(s.slice(0, j) + (s[j] === 'x' ? 'y' : 'x') + s.slice(j + 1), 'binary'));
  return r;
}
function tamperB(rec) {
  const r = structuredClone(rec);
  if (r.key.k === 'ed25519') r.key.p = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  else r.key.p = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return r;
}
function tamperC(rec) {
  const r = structuredClone(rec);
  r.signed_headers.splice(0, 1);
  return r;
}

function tamperE(rec) {
  const r = structuredClone(rec);
  const sg = Buffer.from(r.dkim_signature, 'base64').toString('binary');
  r.dkim_signature = b64(Buffer.from(sg.replace(/(\bb=\s*)([A-Za-z0-9+/]{8})([A-Za-z0-9+/]*)/, (m, a, f, rest) => a + f + (rest[0] === 'A' ? 'B' : 'A') + rest.slice(1)), 'binary'));
  return r;
}
function tamperF(rec) {
  const r = structuredClone(rec);
  const h = r.signed_headers;
  let j = -1;
  for (let k = h.length - 1; k > 0; k--) if (h[k] !== h[0]) { j = k; break; }
  if (j < 0) return null;
  [h[0], h[j]] = [h[j], h[0]];
  return r;
}

async function main() {
  const dir = path.resolve(process.argv[2].replace(/^~/, process.env.HOME));
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.eml')).sort();
  const table = [];
  const notes = [];
  let go = true;
  const items = [];
  for (let n = 0; n < files.length; n++) {
    const raw = fs.readFileSync(path.join(dir, files[n]));
    const { rows, body } = splitMessage(raw);
    const live = await authenticate(raw, { trustReceived: true, disableBimi: true });
    const liveSigs = live.dkim?.results || [];
    const arc = live.arc?.status?.result;
    const sigRows = rows.filter((r) => r.name === 'dkim-signature');
    notes.push(`#${n + 1}: ${sigRows.length} DKIM-Signature(s); dmarc=${live.dmarc?.status?.result}; spf=${live.spf?.status?.result}; arc=${arc}; ARC-Seal count=${rows.filter((r) => r.name === 'arc-seal').length}`);
    for (let si = 0; si < sigRows.length; si++) {
      const sr = sigRows[si];
      const t = parseTags(sr.raw);
      const lv = liveSigs.find((x) => x.signingDomain === t.d && x.selector === t.s && (x.signature || '').toString().startsWith((t.b || '').slice(0, 10)))
        ?? liveSigs.find((x) => x.signingDomain === t.d && x.selector === t.s);
      const liveRes = lv?.status?.result ?? 'n/a';
      let key, off = { ok: false, why: '' }, ta = '-', tb = '-', tc = '-', bm = '-';
      const row = { f: n + 1, d: t.d, s: t.s, a: t.a, c: t.c || 'simple/simple', live: liveRes, l: t.l };
      try {
        key = await fetchKey(t.d, t.s);
        const rcv = rows.find((r) => r.name === 'received');
        const rd = rcv ? Date.parse(rcv.raw.slice(rcv.raw.lastIndexOf(';') + 1).replace(/\s+/g, ' ').trim()) : NaN;
        const rec = buildRecord(rows, sr, key, { captured: Number.isFinite(rd) ? new Date(rd).toISOString() : null, captured_note: 'POC: taken from top-most Received: date of the email; real capture stamps its own time' });
        const file = path.join(OUT, `rec-${n + 1}-${si + 1}.json`);
        fs.writeFileSync(file, JSON.stringify(rec, null, 1));
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8')); // re-load: JSON only
        row.loaded = loaded; row.raw = raw;
        off = recheck(loaded, { at: Date.now() });
        const offAt = recheck(loaded);
        row.cap = offAt.ok ? 'pass' : `fail(${offAt.why})`;
        const sigOnly = recheck(loaded, { at: Date.parse(loaded.captured) });
        row.exp = off.expires ? (off.expired_now ? 'expired' : 'valid') : 'no x=';
        // x= edit inside the signed header must break b=
        const xr = structuredClone(loaded);
        const sg = Buffer.from(xr.dkim_signature, 'base64').toString('binary');
        row.tx = /\bx=\d+/.test(sg) ? (recheck({ ...xr, dkim_signature: b64(Buffer.from(sg.replace(/\bx=(\d+)/, (m, d) => 'x=' + (Number(d) + 1)), 'binary')) }).ok ? 'PASS!' : 'fail') : '-';
        ta = recheck(tamperA(loaded)).ok ? 'PASS!' : 'fail';
        tb = recheck(tamperB(loaded)).ok ? 'PASS!' : 'fail';
        tc = recheck(tamperC(loaded)).ok ? 'PASS!' : 'fail';
        bm = bodyMatch(loaded, body) ? 'match' : 'NO';
        // cross-check canonical bytes against mailauth's own
        if (lv?.signingHeaders?.canonicalizedHeader) {
          const same = Buffer.from(lv.signingHeaders.canonicalizedHeader, 'base64').equals(off.canon ?? Buffer.alloc(0));
          row.bytes = same ? 'same' : 'DIFF';
          if (!same) notes.push(`#${n + 1}.${si + 1}: canonicalized bytes DIFFER from mailauth's`);
        }
      } catch (e) { row.err = e.message; off = { ok: false, why: 'record error: ' + e.message }; }
      row.off = off.ok ? 'pass' : `fail(${off.why})`; row.ta = ta; row.tb = tb; row.tc = tc; row.bm = bm;
      const bodyBad = lv?.status?.comment === 'body hash did not verify';
      const expiredLive = /expired/.test(lv?.status?.comment || '');
      row.agree = bodyBad ? 'n/a(body)' : (liveRes === 'pass' ? off.ok : (!off.ok && (!expiredLive || off.why === 'expired'))) ? 'yes' : 'NO';
      if (row.agree === 'NO') go = false;
      if (!bodyBad && row.cap !== 'pass') go = false;
      if (ta !== 'fail' || tb !== 'fail' || tc !== 'fail' || row.tx === 'PASS!') go = false;
      if (liveRes !== 'pass') notes.push(`#${n + 1}.${si + 1} live=${liveRes} (${lv?.status?.comment ?? 'no live row'}) offline=${row.off} ${off.why} ${row.err ?? ''}`);
      if (t.l) notes.push(`#${n + 1}.${si + 1} uses l=${t.l}`);
      const listed = (t.h || '').split(':').map((x) => x.trim().toLowerCase());
      const missing = listed.filter((x) => !rows.some((r) => r.name === x));
      if (missing.length) notes.push(`#${n + 1}.${si + 1} oversigned/absent h= names: ${[...new Set(missing)].join(',')}`);
      table.push(row);
      if (row.loaded) items.push({ row, rec: row.loaded, raw, bodyBad, off });
    }
  }
  // ---- negative scenarios d..i ----
  for (const it of items) {
    const { row, rec, bodyBad } = it;
    // (d) key replay: a real archived key of a different d= from another sample
    const other = items.find((o) => o.rec.tags.d !== rec.tags.d && o.rec.key.p !== rec.key.p && o.rec.key.k === rec.key.k);
    row.td = other ? (recheck({ ...structuredClone(rec), key: structuredClone(other.rec.key) }).ok ? 'PASS!' : 'fail') : 'n/a';
    // (e) flipped b=
    row.te = recheck(tamperE(rec)).ok ? 'PASS!' : 'fail';
    // (f) reorder signed_headers
    const rf = tamperF(rec);
    row.tf = rf ? (recheck(rf).ok ? 'PASS!' : 'fail') : 'n/a';
    // (g) body swap: own raw passes, different email's raw fails
    const diff = items.find((o) => o.row.f !== row.f && o.rec.tags.bh !== rec.tags.bh);
    const ownOk = matchBody(rec, it.raw);
    const swapBad = diff ? !matchBody(rec, diff.raw) : null;
    row.tg = (ownOk ? 'own:ok' : 'own:no') + '/' + (swapBad === null ? 'n/a' : swapBad ? 'swap:fail' : 'swap:PASS!');
    // (h) expired at capture / future t=
    const x = Number(rec.tags.x), t = Number(rec.tags.t);
    const he = rec.tags.x ? recheck(rec, { at: (x + 1) * 1000 }) : null;
    const hf = rec.tags.t ? recheck(rec, { at: (t - 301) * 1000 }) : null;
    row.th = (he ? (!he.ok && he.why === 'expired' ? 'exp:fail' : 'exp:PASS!') : 'exp:-') + '/' + (hf ? (!hf.ok ? 'fut:fail' : 'fut:PASS!') : 'fut:-');
    // (i) missing/garbled captured
    const bad = [undefined, null, '', 'not-a-date', 'garbage'].map((v) => { const r = structuredClone(rec); if (v === undefined) delete r.captured; else r.captured = v; return recheck(r).ok; });
    row.ti = bad.some(Boolean) ? 'PASS!' : 'fail';
    if (row.td === 'PASS!' || row.te === 'PASS!' || row.tf === 'PASS!' || /PASS!/.test(row.tg) || /PASS!/.test(row.th) || row.ti === 'PASS!') go = false;
    if (!ownOk && !bodyBad) go = false;
  }
  const cols = ['f', 'd', 's', 'a', 'c', 'live', 'bytes', 'off', 'agree', 'cap', 'exp', 'tx', 'ta', 'tb', 'tc', 'bm', 'td', 'te', 'tf', 'tg', 'th', 'ti'];
  console.log(['file#', 'd=', 's=', 'a=', 'c=', 'live DKIM', 'bytes vs mailauth', 'offline(now)', 'agrees live', 'recheck@captured', 'x=', 'x-edit', 'tamper a', 'b', 'c', 'body', 'd key-replay', 'e flip b=', 'f reorder', 'g body-swap', 'h expired/future', 'i captured'].join(' | '));
  for (const r of table) console.log(cols.map((k) => r[k]).join(' | '));
  console.log('\nNotes:'); notes.forEach((x) => console.log(' ' + x));
  console.log('\nCanonicalization source: mailauth/lib/dkim/header (+ lib/dkim/body for body hash)');
  const livePass = table.filter((r) => r.live === 'pass').length;
  console.log(`\nlive-pass signatures: ${livePass}/${table.length}`);
  const nBody = table.filter((r) => r.agree === 'n/a(body)').length;
  console.log(`agreement n/a due to body mismatch: ${nBody}`);
  console.log(livePass === 0 ? 'INCONCLUSIVE (no signature verified live; GO criterion cannot be evaluated)' : go ? 'GO' : 'NO-GO');
}
if (import.meta.url === `file://${process.argv[1]}`) main();
