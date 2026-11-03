// M1 go/no-go POC (throwaway, never shipped): READ-ONLY IMAP capture from a real Gmail account, then
// check() the fetched bytes. Usage: node poc/m1-imap/m1-imap-poc.mjs   (see README.md)
// Env: M1_SCRATCH (required; holds raw mail, trail, wire log and results: nothing real goes in the repo),
//      M1_IMAPFLOW_DIR (dir whose node_modules has imapflow; default $M1_SCRATCH/imapflow-eval),
//      M1_USER (account), M1_PASS_ENTRY (pass entry, default mailproof/gmail_pass), M1_CAP (messages per folder, 30).
// The password is read from `pass` at runtime only. It never goes to disk, argv, env or output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { Mailproof } from '../../src/index.js';
import { authenticate } from 'mailauth';

const SCRATCH = process.env.M1_SCRATCH;
if (!SCRATCH) throw new Error('set M1_SCRATCH to a scratch directory outside the repo');
const IMAPFLOW_DIR = process.env.M1_IMAPFLOW_DIR || path.join(SCRATCH, 'imapflow-eval');
const USER = process.env.M1_USER;
if (!USER) throw new Error('set M1_USER to the Gmail address');
const CAP = Number(process.env.M1_CAP || 30);
const { ImapFlow } = createRequire(path.join(IMAPFLOW_DIR, 'x.js'))('imapflow');

const MAIL = path.join(SCRATCH, 'm1-mail'), TRAIL = path.join(SCRATCH, 'm1-trail');
fs.mkdirSync(MAIL, { recursive: true });
const pass = execFileSync('pass', ['show', process.env.M1_PASS_ENTRY || 'mailproof/gmail_pass'], { encoding: 'utf8' }).split('\n')[0].trim().replace(/\s+/g, '');   // Google shows app passwords in groups of 4 with spaces; the spaces are not part of it

// ---- wire log: every line redacted of the secret and of LOGIN/AUTHENTICATE; message bodies are not logged ----
const wire = fs.createWriteStream(path.join(SCRATCH, 'm1-wire.log'));
const red = (s) => String(s).split(pass).join('<REDACTED>').replace(/(LOGIN|AUTHENTICATE).*/gi, '$1 <REDACTED>').replace(USER, '<USER>').replace(/^[A-Za-z0-9+\/=]{16,}$/, '<SASL-RESPONSE REDACTED>').replace(/\d+:\d+:\d+:\d+:\d+:\d+:\d+:\d+/g, '<IP>');
const logger = {
  debug: (o) => { if (o && o.msg) wire.write(`${o.src || '-'} ${red(o.msg)}${o.src === 's' && o.data ? ` [${Buffer.from(o.data, 'base64').length}b]` : ''}\n`); },
  info() {}, warn: (o) => wire.write(`WARN ${red(JSON.stringify(o).slice(0, 200))}\n`), error: (o) => wire.write(`ERR ${red(JSON.stringify(o).slice(0, 200))}\n`),
};

const OK_DOMAINS = new Set(['gmail.com', 'google.com', 'googlemail.com', 'microsoft.com', 'outlook.com', 'hotmail.com', 'msn.com', 'amazonses.com', 'github.com', 'linkedin.com', 'facebookmail.com', 'paypal.com', 'apple.com', 'icloud.com']);
const anon = (d) => { d = String(d || '').toLowerCase(); return OK_DOMAINS.has(d) ? d : '(other)'; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tally = (m, k) => { m[k] = (m[k] || 0) + 1; };
const out = { notes: [] };

function headerBlock(raw) { const s = raw.toString('latin1'); const i = s.search(/\r?\n\r?\n/); return i < 0 ? s : s.slice(0, i); }
function unfold(h) { return h.replace(/\r?\n[ \t]+/g, ' '); }
function headersNamed(raw, name) { return unfold(headerBlock(raw)).split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':')); }
const tag = (l, t) => (new RegExp(`(?:^|[;:\\s])${t}=([^;\\s]+)`, 'i').exec(l) || [])[1];

const mp = new Mailproof({ trailDir: TRAIL, trail: 'm1' });
const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: USER, pass }, logger, emitLogs: false, disableCompression: true });
const bytesRead = () => client.socket.bytesRead;

async function fetchFolder(path_) {
  const lock = await client.getMailboxLock(path_, { readOnly: true });
  try {
    const mb = client.mailbox;
    const info = { path: '(folder)', readOnly: mb.readOnly, uidValidityIsBigInt: typeof mb.uidValidity === 'bigint', uidNext: mb.uidNext, exists: mb.exists };
    const first = Math.max(1, mb.exists - CAP + 1);
    const msgs = [];
    for await (const m of client.fetch(`${first}:*`, { uid: true, size: true, source: true })) msgs.push({ uid: m.uid, size: m.size, raw: m.source });
    return { info, msgs, uidValidity: mb.uidValidity, uidNext: mb.uidNext };
  } finally { lock.release(); }
}

const t0 = Date.now();
await client.connect();                                              // Q1
out.q1 = { login: 'ok', tls: client.secureConnection !== false, capabilityAuth: [...client.capabilities.keys()].filter((k) => /^AUTH/i.test(k)), ms: Date.now() - t0 };
const boxes = await client.list();
const sent = boxes.find((b) => b.specialUse === '\\Sent');
out.folders = { count: boxes.length, specialUse: boxes.filter((b) => b.specialUse).map((b) => b.specialUse), sentFound: Boolean(sent) };
if (!sent) throw new Error('no \\Sent folder');

const folders = { INBOX: 'INBOX', Sent: sent.path };
const got = {};
for (const [label, p] of Object.entries(folders)) {
  got[label] = await fetchFolder(p);
  got[label].msgs.forEach((m) => fs.writeFileSync(path.join(MAIL, `${label}-${m.uid}.eml`), m.raw));
}

// ---- Q2: check() every message, cross-check with mailauth on the same bytes ----
out.q2 = {};
const arcObs = {};
for (const [label, g] of Object.entries(got)) {
  const q = { n: g.msgs.length, sizeEqualsLength: 0, sizeMismatch: 0, portable: {}, live: {}, portableReason: {}, liveReason: {}, unsigned: 0, signed: 0, sigDomains: {}, agreeWithMailauth: 0, disagree: [], overLimit: 0, bodyStatus: {} };
  const a = { withARCSeal: 0, withARCAMS: 0, withARCAAR: 0, withAuthResults: 0, arcSealers: {}, arcMaxInstance: {}, arAuthservs: {}, arHasSpf: 0, arHasDkim: 0, arHasDmarc: 0, arcSealCoversSpf: 0, arcAarHasSpf: 0, arcChainResult: {}, dkimSigners: {}, receivedSpf: 0 };
  for (const m of g.msgs) {
    if (m.size === m.raw.length) q.sizeEqualsLength++; else q.sizeMismatch++;
    const c = await mp.check(m.raw);
    tally(q.portable, c.portable.trust); tally(q.live, c.live.trust);
    tally(q.portableReason, String(c.portable.reason || '').replace(/[^ -~]/g, '').slice(0, 60)); tally(q.liveReason, String(c.live.reason || '').slice(0, 60));
    tally(q.bodyStatus, String(c.body_status && c.body_status.status || c.body_status));
    if (c.unsigned) q.unsigned++; else q.signed++;
    if (String(c.portable.reason || '').startsWith('over limit')) q.overLimit++;
    // direct mailauth, no ip/helo so SPF is skipped, same as check() without an envelope
    const ma = await authenticate(m.raw, { disableBimi: true, trustReceived: false });
    const dk = ma.dkim.results || [];
    const dkPass = dk.some((r) => r.status.result === 'pass');
    const mailauthVerified = dk.some((r) => r.status.result === 'pass' && r.status.aligned) && (!ma.dmarc || ma.dmarc.status.result !== 'fail');
    for (const r of dk) tally(q.sigDomains, anon(r.signingDomain));
    const mpVerified = c.portable.trust === 'verified';
    // portable has no DMARC; compare portable to mailauth's DKIM-only view, live to DKIM+DMARC
    const mpDkimPass = c.portable.trust === 'verified' || c.portable.trust === 'forwarded' || c.portable.trust === 'authorized';
    if (mpDkimPass === dkPass && (c.live.trust === 'verified') === mailauthVerified) q.agreeWithMailauth++;
    else q.disagree.push({ portable: c.portable.trust, live: c.live.trust, mailauthDkimPass: dkPass, mailauthVerified });
    // Q4 observations
    const seals = headersNamed(m.raw, 'ARC-Seal'), ams = headersNamed(m.raw, 'ARC-Message-Signature'), aar = headersNamed(m.raw, 'ARC-Authentication-Results'), ar = headersNamed(m.raw, 'Authentication-Results');
    if (seals.length) a.withARCSeal++; if (ams.length) a.withARCAMS++; if (aar.length) a.withARCAAR++; if (ar.length) a.withAuthResults++;
    for (const s of seals) tally(a.arcSealers, anon(tag(s, 'd')));
    if (seals.length) tally(a.arcMaxInstance, String(seals.length));
    for (const l of ar) { tally(a.arAuthservs, anon(/^authentication-results:\s*([^;\s]+)/i.exec(l)[1])); if (/\bspf=/i.test(l)) a.arHasSpf++; if (/\bdkim=/i.test(l)) a.arHasDkim++; if (/\bdmarc=/i.test(l)) a.arHasDmarc++; }
    if (aar.some((l) => /\bspf=/i.test(l))) a.arcAarHasSpf++;
    if (headersNamed(m.raw, 'Received-SPF').length) a.receivedSpf++;
    if (ma.arc) tally(a.arcChainResult, String(ma.arc.status && ma.arc.status.result));
    for (const d of headersNamed(m.raw, 'DKIM-Signature')) tally(a.dkimSigners, anon(tag(d, 'd')));
  }
  out.q2[label] = q; arcObs[label] = a;
}
out.q3_sent = { signed: out.q2.Sent.signed, unsigned: out.q2.Sent.unsigned, sigDomains: out.q2.Sent.sigDomains };
out.q4 = arcObs;

// exactness: fetch one message twice, compare sha256 with the first fetch and the stored file
{
  const g = got.INBOX; const m = g.msgs[g.msgs.length - 1]; const lock = await client.getMailboxLock(folders.INBOX, { readOnly: true });
  try {
    const hs = [];
    for (let i = 0; i < 2; i++) { const r = await client.fetchOne(String(m.uid), { source: true }, { uid: true }); hs.push(sha(r.source)); }
    out.q2_exact = { refetchSame: hs[0] === hs[1], sameAsFirstFetch: hs[0] === sha(m.raw), sameAsFileOnDisk: hs[0] === sha(fs.readFileSync(path.join(MAIL, `INBOX-${m.uid}.eml`))) };
  } finally { lock.release(); }
}

// ---- Q5: resume ----
{
  const g = got.INBOX, uids = g.msgs.map((m) => m.uid), last = Math.max(...uids), prev = [...uids].sort((a, b) => a - b).at(-2);
  const lock = await client.getMailboxLock(folders.INBOX, { readOnly: true });
  try {
    const run = async (lastUid) => { const r = []; for await (const m of client.fetch(`${lastUid + 1}:*`, { uid: true }, { uid: true })) r.push(m.uid); return r; };
    const none = await run(last), one = await run(prev), beyond = await run(last + 100000);
    out.q5 = {
      uidValidityBigInt: g.info.uidValidityIsBigInt, uidValidityDigits: String(g.uidValidity).length, uidNextGtLast: g.uidNext > last,
      nothingNew: { requested: `${last + 1}:*`, returned: none.length, returnedLastUid: none[0] === last, afterFilterUidGtLast: none.filter((u) => u > last).length },
      oneNew: { returned: one.length, afterFilter: one.filter((u) => u > prev).length },
      farBeyond: { returned: beyond.length, afterFilter: beyond.filter((u) => u > last + 100000).length },
    };
  } finally { lock.release(); }
}

// ---- Q6: size bound ----
{
  const g = got.INBOX; const big = g.msgs.reduce((a, b) => (b.size > a.size ? b : a));
  const lock = await client.getMailboxLock(folders.INBOX, { readOnly: true });
  const q6 = { largestBytes: big.size };
  try {
    let b0 = bytesRead();
    const s = await client.fetchOne(String(big.uid), { size: true }, { uid: true });
    q6.sizeOnly = { reportedSize: s.size, bytesOnWire: bytesRead() - b0 };
    b0 = bytesRead();
    const part = await client.fetchOne(String(big.uid), { source: { start: 0, maxLength: 4096 } }, { uid: true });
    q6.maxLength4096 = { returnedBytes: part.source.length, bytesOnWire: bytesRead() - b0, equalsPrefix: Buffer.compare(part.source, big.raw.subarray(0, 4096)) === 0 };
    const lim = big.size - 1;
    b0 = bytesRead();
    const p2 = await client.fetchOne(String(big.uid), { source: { start: 0, maxLength: lim } }, { uid: true });
    q6.maxLengthSizeMinus1 = { returnedBytes: p2.source.length, isOneShort: p2.source.length === lim };
    b0 = bytesRead();
    const full = await client.fetchOne(String(big.uid), { source: true }, { uid: true });
    q6.fullFetch = { returnedBytes: full.source.length, bytesOnWire: bytesRead() - b0 };
    // streaming download aborted early: does the wire stop?
    b0 = bytesRead();
    let got_ = 0; const t1 = Date.now();
    try {
      const dl = await client.download(String(big.uid), undefined, { uid: true });
      await new Promise((res) => { dl.content.on('data', (d) => { got_ += d.length; if (got_ >= 4096) { dl.content.destroy(); res(); } }); dl.content.on('end', res); dl.content.on('close', res); dl.content.on('error', res); });
      q6.downloadAbort = { consumedBytes: got_, bytesOnWire: bytesRead() - b0, ms: Date.now() - t1 };
    } catch (e) { q6.downloadAbort = { error: String(e.message).slice(0, 80) }; }
  } finally { lock.release(); }
  out.q6 = q6;
}

try { await client.logout(); } catch { /* ignore */ }
await mp.close();
wire.end();
out.readOnlyCommandsSent = (fs.readFileSync(path.join(SCRATCH, 'm1-wire.log'), 'utf8').match(/^c .*$/gm) || []).map((l) => (l.split(/ +/)[2] || '').toUpperCase()).filter(Boolean).reduce((m, k) => { m[k] = (m[k] || 0) + 1; return m; }, {});
fs.writeFileSync(path.join(SCRATCH, 'm1-results.json'), JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
console.log(JSON.stringify(out, null, 2));
