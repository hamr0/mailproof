// M3 replyFacts POC harness. Usage: node poc/m3-reply-facts/run.mjs [dir ...]
// env: M3_REVIEW (review folder, default ~/mailproof-m3-replyfacts-review), M3_PAD (padding records for the cost run, default 2000)
// Console output is aggregate only. Per-sample detail (incl. extracted text) goes ONLY to the review folder, outside the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replyFacts, candidates, choose, linkOf, recordCommit, SEP } from './facts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { Mailproof } = await import(path.join(root, 'src/index.js'));
const { makeTmpDir } = await import(path.join(root, 'tests/helpers/tmp.js'));
const home = os.homedir();
const dirs = process.argv.length > 2 ? process.argv.slice(2) : [
  ...fs.readdirSync(home).filter((n) => n.startsWith('mailproof-m0-samples')).map((n) => path.join(home, n)),
  path.join(home, 'PycharmProjects/gitdone/poc/phase0'), path.join(home, 'mail-samples/m2-replies'),
].filter((d) => fs.existsSync(d));
const review = process.env.M3_REVIEW || path.join(home, 'mailproof-m3-replyfacts-review');
const PAD = Number(process.env.M3_PAD ?? 2000);
fs.mkdirSync(review, { recursive: true, mode: 0o700 }); fs.chmodSync(review, 0o700);

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.eml$/i.test(e.name) ? [path.join(d, e.name)] : []);
const seenSha = new Set(); const files = [];
for (const d of dirs) for (const f of walk(d).sort()) {
  const raw = fs.readFileSync(f); const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (seenSha.has(sha)) continue; seenSha.add(sha);
  files.push({ f, raw, dir: /sent/i.test(path.basename(path.dirname(f)) + path.basename(d)) || /sent/i.test(d) ? 'out' : 'in' });
}
const tally = (list, keyf) => { const m = new Map(); for (const x of list) { const k = keyf(x); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort(); };
const show = (title, entries) => { console.log('\n' + title); for (const [k, v] of entries) console.log(`  ${String(k).padEnd(52)} ${v}`); };
const ms = async (fn) => { const t = process.hrtime.bigint(); const r = await fn(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const fmt = (n) => Number.isNaN(n) ? 'n/a' : n.toFixed(1);

const tmp = makeTmpDir('m3-replyfacts-');
const mp = new Mailproof({ trailDir: tmp, worker: { size: 0 } });
console.log('M3 replyFacts POC. files (distinct bytes):', files.length, ' by assumed direction:', JSON.stringify(Object.fromEntries(tally(files, (x) => x.dir))));

// ---- 1. record everything ----
const recs = []; let recordErr = 0;
for (const x of files) {
  try { const r = await mp.record(x.raw, { direction: x.dir }); recs.push({ ...x, id: r.id, rec: await mp.get(r.id) }); } catch (e) { recordErr++; }
}
console.log('recorded:', recs.length, ' errors:', recordErr);
const domainOf = (a) => (a || '').split('@')[1]?.toLowerCase() ?? '';
function provider(rec) {
  const fd = domainOf(rec.message.from); const md = (rec.message.message_id || '').replace(/^<|>$/g, '').split('@')[1]?.toLowerCase() ?? '';
  if (/(^|\.)(gmail|googlemail)\.com$/.test(fd) || /gmail\.com$/.test(md)) return 'Gmail';
  if (/(^|\.)(outlook|hotmail|live|msn|office365|microsoft)\.com$/.test(fd) || /outlook\.com$|hotmail|prod\.outlook/.test(md)) return 'Microsoft';
  return 'other';
}
const mids = new Map(recs.map((r) => [r.rec.message.message_id, r.id]));
const inbound = recs.filter((r) => r.rec.direction === 'in');
const replies = inbound.filter((r) => r.rec.message.in_reply_to || (r.rec.message.references ?? []).length);
const withParentRecorded = replies.filter((r) => mids.has(r.rec.message.in_reply_to) || (r.rec.message.references ?? []).some((m) => mids.has(m)));
console.log(`inbound: ${inbound.length}; with In-Reply-To/References: ${replies.length}; whose request is among the samples: ${withParentRecorded.length}`);
show('provider class of the replies', tally(replies, (r) => provider(r.rec)));

// ---- 2. arm A: request NOT recorded (messageId = the reply's In-Reply-To) ----
const asked = (r) => r.rec.message.in_reply_to || (r.rec.message.references ?? []).slice(-1)[0];
let aFound = 0, aScanFound = 0;
for (const r of replies) {
  const a = await candidates(mp, asked(r), { strategy: 'linked' });
  const b = await candidates(mp, asked(r), { strategy: 'scan' });
  if (a.rows.length) aFound++; if (b.rows.length) aScanFound++;
}
console.log(`\nARM A (request not recorded unless in samples): 'linked' lookup finds the reply for ${aFound}/${replies.length}; full scan finds it for ${aScanFound}/${replies.length}`);

// ---- 3. arm B: record a synthetic stand-in request (unsigned, no sample text) for every missing target ----
let synth = 0;
for (const r of replies) {
  const mid = asked(r); if (mids.has(mid)) continue;
  const raw = Buffer.from(`From: owner@example.invalid\r\nTo: x@example.invalid\r\nMessage-ID: ${mid}\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\nSubject: request\r\n\r\nplease approve\r\n`);
  const o = await mp.record(raw, { direction: 'out' }); mids.set(mid, o.id); synth++;
}
console.log(`ARM B: ${synth} synthetic stand-in requests recorded (unsigned, fixed text); requests that were real sent mail: ${replies.length - synth}`);

// ---- 4. bundles on every reply ----
const rows = []; const detail = [];
for (const [i, r] of replies.entries()) {
  const mid = asked(r); const sid = 'R' + String(i + 1).padStart(2, '0');
  const [A, tA] = await ms(() => replyFacts(mp, { messageId: mid, strategy: 'linked', textMode: 'pure' }));
  const [B] = await ms(() => replyFacts(mp, { messageId: mid, strategy: 'scan', textMode: 'pure' }));
  const [C, tC] = await ms(() => replyFacts(mp, { messageId: mid, strategy: 'linked', textMode: 'public' }));
  const b = A.bundle;
  rows.push({ sid, prov: provider(r.rec), b, same: JSON.stringify(A.bundle) === JSON.stringify(B.bundle), samePub: JSON.stringify(A.bundle) === JSON.stringify(C.bundle), tA, tC, pick: A.pick, realRequest: r.rec.message.in_reply_to && !!recs.find((x) => x.id === mids.get(mid)) });
  detail.push({ sid, file: r.f, bundle: b });
}
// the chosen record is not always the one we started from (earlier/signed candidate wins): count how often
const startedFrom = replies.map((r) => r.id);
console.log('\nbundles:', rows.filter((x) => x.b).length, '/', replies.length, ' linked-strategy == scan-strategy:', rows.filter((x) => x.same).length, ' pure-text == public-text bundle:', rows.filter((x) => x.samePub).length);
console.log('replies that name the request but are not its immediate child (excluded):', rows.reduce((n, x) => n + (x.pick?.deeper ?? 0), 0), '; replies chosen only via References (no In-Reply-To):', replies.filter((r) => !r.rec.message.in_reply_to).length);
console.log('chosen record differs from the reply we started from:', rows.filter((x, i) => x.b && x.b.recordId !== startedFrom[i]).length);
const B = rows.filter((x) => x.b);
show('link x provider', tally(B, (x) => `${x.b.link} | ${x.prov}`));
show('bodyProven x provider', tally(B, (x) => `${x.b.bodyProven} | ${x.prov}`));
show('quote x provider', tally(B, (x) => `${x.b.quote} | ${x.prov}`));
show('fromDkimAligned x provider', tally(B, (x) => `${x.b.fromDkimAligned} | ${x.prov}`));
show('firstLine empty/non-empty x provider', tally(B, (x) => `${x.b.firstLine === '' ? 'empty' : 'non-empty'} | ${x.prov}`));
show('dkim / dmarc / spf / arc (closed values)', [...tally(B, (x) => 'dkim ' + x.b.dkim), ...tally(B, (x) => 'dmarc ' + x.b.dmarc), ...tally(B, (x) => 'spf ' + x.b.spf), ...tally(B, (x) => 'arc ' + x.b.arc), ...tally(B, (x) => 'live ' + x.b.live), ...tally(B, (x) => 'portable ' + x.b.portable)]);
show('green on the PRD recipe (from ok, aligned pass, proven, link signed) by provider', tally(B, (x) => `${x.b.fromDkimAligned === 'pass' && x.b.bodyProven === 'proven' && x.b.link === 'signed' ? 'green' : 'not green'} | ${x.prov}`));
const empties = { dateEmpty: B.filter((x) => x.b.date === '').length, subjectEmpty: B.filter((x) => x.b.subject === '').length, commitEmpty: B.filter((x) => x.b.commit === '').length, messageIdEmpty: B.filter((x) => x.b.messageId === '').length, fromEmpty: B.filter((x) => x.b.from === '').length, toEmpty: B.filter((x) => x.b.to === '').length, ccNonEmpty: B.filter((x) => x.b.cc !== '').length, attachNonEmpty: B.filter((x) => x.b.attachments !== '').length, aliveTextEmpty: B.filter((x) => x.b.text === '').length };
console.log('\nfield emptiness (of', B.length + '):', JSON.stringify(empties));
console.log('all values strings:', B.every((x) => Object.values(x.b).every((v) => typeof v === 'string')), ' fields per bundle:', Object.keys(B[0]?.b ?? {}).length);
// separator safety, measured on every address and attachment hash seen
const addrs = recs.flatMap((r) => (r.rec.addresses ?? []).map((a) => a.raw)); const hashes = recs.flatMap((r) => r.rec.attachments.map((a) => a.sha256).filter(Boolean));
console.log(`separator check: ${addrs.length} addresses, ${hashes.length} attachment hashes; with ',' ${addrs.filter((a) => a.includes(',')).length}/${hashes.filter((a) => a.includes(',')).length}; with whitespace ${addrs.filter((a) => /\s/.test(a)).length}/${hashes.filter((a) => /\s/.test(a)).length}; with ';' ${addrs.filter((a) => a.includes(';')).length}; hash shape sha256:<64 hex> ${hashes.filter((h) => /^sha256:[0-9a-f]{64}$/.test(h)).length}/${hashes.length}; multi-To bundles ${B.filter((x) => x.b.to.includes(SEP)).length}, multi-Cc ${B.filter((x) => x.b.cc.includes(SEP)).length}, multi-attachment ${B.filter((x) => x.b.attachments.includes(SEP)).length}`);
console.log('raw != lower-cased from (case matters):', B.filter((x) => x.b.from !== x.b.fromRaw).length, '/', B.length);
console.log('firstLine: starts/ends with whitespace (must be 0):', B.filter((x) => x.b.firstLine !== x.b.firstLine.trim()).length);

// ---- 5. lookup behaviour: 0 / 1 / >1 replies, copies. Real data first. ----
const perReq = new Map();
for (const r of inbound) for (const m of new Set([r.rec.message.in_reply_to, ...(r.rec.message.references ?? [])].filter(Boolean))) perReq.set(m, (perReq.get(m) || 0) + 1);
show('REAL data: inbound records naming one Message-ID (as In-Reply-To/References), count of ids by n', tally([...perReq.values()], (n) => n >= 3 ? '3+' : n));
const keyGroups = tally(inbound.filter((r) => r.rec.message_key), (r) => r.rec.message_key).filter(([, n]) => n > 1).length;
console.log('REAL data: message_keys with >1 recorded copy:', keyGroups, 'of', new Set(inbound.map((r) => r.rec.message_key).filter(Boolean)).size);
// SYNTHETIC scenarios (labelled; test helpers, example.* domains, no sample content): signed link, copies, >1 replies, 0 replies
const { buildThread } = await import(path.join(root, 'tests/helpers/thread-trail.js'));
const th = await buildThread();
const REQ = '<req@owner.example>'; const sign = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references'];
const quoted = 'APPROVE\r\n\r\nOn Mon, 1 Nov 2026, Owner <me@owner.example> wrote:\r\n> Approve?\r\n';
const scen = {};
const f0 = await replyFacts(th.mp, { messageId: '<no-such-request@poc.invalid>', textMode: 'pure' });
scen.zeroReplies = f0.bundle === null;
// existing thread: 1 signed, 1 unsigned (Microsoft-like), 1 failing reply to REQ -> 3 distinct inbound messages
const t1 = await replyFacts(th.mp, { messageId: REQ, textMode: 'pure' });
scen.threeDistinctReplies = { inbound: t1.pick.inbound, deeperThreadMembersExcluded: t1.pick.deeper, distinctMessages: t1.pick.distinctMessages, chosen: t1.bundle.recordId === th.r.signed.id ? 'the signed one' : 'other', link: t1.bundle.link, aligned: t1.bundle.fromDkimAligned };
// a relayed copy of the signed reply (unsigned header prepended: DKIM still verifies, new id, same message_key)
const copy = await th.mp.record(Buffer.concat([Buffer.from('X-Poc-Relay: 1\r\n'), th.mails.signed.raw]), { direction: 'in' });
const crec = await th.mp.get(copy.id);
const t2 = await replyFacts(th.mp, { messageId: REQ, textMode: 'pure' });
scen.copyOfSignedReply = { sameMessageKey: crec.message_key === th.r.signed.message_key, distinctId: copy.id !== th.r.signed.id, copyKind: crec.copy.kind, inbound: t2.pick.inbound, distinctMessages: t2.pick.distinctMessages, copiesMax: t2.pick.copiesMax, deeper: t2.pick.deeper, picksEarliestCopy: t2.bundle.recordId === th.r.signed.id };
// a NEW distinct signed reply to the SAME request, captured later (a second answer)
th.clock.t = new Date(th.clock.t.getTime() + 3600e3);
const again = await th.mk('beta.example', { from: 'Bob <Bob@Beta.Example>', to: 'me@owner.example', messageId: '<r8@beta.example>', inReplyTo: REQ, references: REQ, headerList: sign, body: 'DENY\r\n' });
await th.mp.record(again.raw, { direction: 'in' });
const t3 = await replyFacts(th.mp, { messageId: REQ, textMode: 'pure' });
scen.secondSignedReply = { distinctMessages: t3.pick.distinctMessages, earliestSignedStillChosen: t3.bundle.recordId === th.r.signed.id, laterAnswerIgnored: t3.bundle.firstLine !== 'DENY' };
scen.scanEqualsLinked = JSON.stringify(t3.bundle) === JSON.stringify((await replyFacts(th.mp, { messageId: REQ, textMode: 'pure', strategy: 'scan' })).bundle);
// a happy-path reply to its own request: quoted body, mixed-case From, Cc list
const REQ2 = '<req2@owner.example>';
th.clock.t = new Date(th.clock.t.getTime() + 3600e3);
await th.mp.record(Buffer.from(`From: Owner <me@owner.example>\r\nTo: Bob@Beta.Example\r\nMessage-ID: ${REQ2}\r\nDate: Mon, 01 Nov 2026 10:00:00 +0000\r\nSubject: Approve 2?\r\n\r\nReply APPROVE\r\n`), { direction: 'out' });
th.clock.t = new Date(th.clock.t.getTime() + 60e3);
const second = await th.mk('beta.example', { from: 'Bob <Bob@Beta.Example>', to: 'me@owner.example', messageId: '<r9@beta.example>', inReplyTo: REQ2, references: REQ2, headerList: sign, body: quoted, extraHeaders: ['Cc: Eve@Beta.Example, frank@beta.example'] });
await th.mp.record(second.raw, { direction: 'in' });
const h = (await replyFacts(th.mp, { messageId: REQ2, textMode: 'pure' })).bundle;
const green = (b) => b.fromDkimAligned === 'pass' && b.bodyProven === 'proven' && b.link === 'signed';
console.log('SYNTHETIC scenarios:', JSON.stringify({ ...scen, happyPathRecipeGreen: green(h) }));
console.log('SYNTHETIC happy-path bundle (example.* test data, safe to show):'); console.log(JSON.stringify({ ...h, commit: '<sha>', recordId: '<id>' }, null, 1));
th.mp.close?.();

// ---- 6. cost ----
const probe = replies[0]; const pmid = asked(probe);
const cost = async (label) => {
  const ts = { linked_pure: [], linked_public: [], scan_pure: [], linkedOnly: [], listOnly: [], commitOnly: [], getOnly: [], rawOnly: [] };
  await replyFacts(mp, { messageId: pmid, textMode: 'pure' });  // warm the index
  for (let i = 0; i < 7; i++) {
    ts.linked_pure.push((await ms(() => replyFacts(mp, { messageId: pmid, strategy: 'linked', textMode: 'pure' })))[1]);
    ts.linked_public.push((await ms(() => replyFacts(mp, { messageId: pmid, strategy: 'linked', textMode: 'public' })))[1]);
    ts.commitOnly.push((await ms(() => recordCommit(mp.root, mids.get(pmid))))[1]);
    ts.getOnly.push((await ms(() => mp.get(mids.get(pmid))))[1]);
    ts.rawOnly.push((await ms(() => mp.rawEmail(mids.get(pmid))))[1]);
    ts.listOnly.push((await ms(() => mp.list({ limit: 1e9 })))[1]);
    ts.linkedOnly.push((await ms(() => mp.linked(mids.get(pmid))))[1]);
    if (i < 3) ts.scan_pure.push((await ms(() => replyFacts(mp, { messageId: pmid, strategy: 'scan', textMode: 'pure' })))[1]);
  }
  const n = (await mp.list({ limit: 1e9 })).length;
  console.log(`COST at ${n} records (median ms): replyFacts linked+pure-text ${fmt(median(ts.linked_pure))}; linked+public replyText ${fmt(median(ts.linked_public))}; scan strategy ${fmt(median(ts.scan_pure))}; of which list(all) ${fmt(median(ts.listOnly))}, linked(id) ${fmt(median(ts.linkedOnly))}, git-log commit lookup ${fmt(median(ts.commitOnly))}, get ${fmt(median(ts.getOnly))}, rawEmail ${fmt(median(ts.rawOnly))}`);
};
await cost('base');
let have = (await mp.list({ limit: 1e9 })).length;
for (const target of [PAD, PAD * 5].filter((n) => n > 0)) {
  const t0 = Date.now();
  for (let i = have; i < target; i++) await mp.record(Buffer.from(`From: pad${i % 50}@example.invalid\r\nTo: owner@example.invalid\r\nMessage-ID: <pad-${i}@example.invalid>\r\nDate: Mon, 01 Jan 2024 00:00:00 +0000\r\nSubject: pad ${i}\r\n\r\npadding ${i}\r\n`), { direction: i % 2 ? 'in' : 'out' });
  have = target; console.log(`(padded to ${target} in ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  await cost('pad');
  if (process.env.M3_FAST) break;
}

// ---- review folder (private) ----
let md = '# M3 replyFacts review (private; never copy into the repo)\n\nEach Rxx.json is the bundle for one real reply, built with the request Message-ID = the reply\'s In-Reply-To.\n\n| id | file | provider | link | bodyProven | quote | fromDkimAligned | firstLine empty |\n|---|---|---|---|---|---|---|---|\n';
for (const d of detail) { const x = rows.find((r) => r.sid === d.sid); if (!d.bundle) continue; fs.writeFileSync(path.join(review, d.sid + '.json'), JSON.stringify(d.bundle, null, 2) + '\n', { mode: 0o600 }); md += `| ${d.sid} | ${d.file} | ${x.prov} | ${d.bundle.link} | ${d.bundle.bodyProven} | ${d.bundle.quote} | ${d.bundle.fromDkimAligned} | ${d.bundle.firstLine === ''} |\n`; }
fs.writeFileSync(path.join(review, 'INDEX.md'), md, { mode: 0o600 });
await mp.close();
fs.rmSync(tmp, { recursive: true, force: true });
