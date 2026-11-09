// Trust profiles and graded proof per part (SPEC B8) on real captured mail: checkProfile (pure and method) and proofParts.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkProfile, Mailproof } from '../../src/index.js';
import { RULES_VERSION } from '../../src/proof/verdict.js';
import { buildThread, makeDomains, T0 } from '../helpers/thread-trail.js';
import { stubResolver } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

const REQ = '<req@owner.example>';
const rules = (out) => out.failed.map((f) => f.rule);

test('the pure checkProfile is exported from the package entry', () => {
  assert.equal(typeof checkProfile, 'function');
  assert.equal(typeof Mailproof.prototype.checkProfile, 'function');
});

test('senders: exact address and @domain match the signed, aligned From; case-insensitive; exact domain only', async () => {
  const { r } = await buildThread();
  const ok = (senders) => checkProfile(r.signed, { senders }).ok;
  assert.equal(ok(['bob@beta.example']), true);
  assert.equal(ok(['BOB@Beta.Example']), true);
  assert.equal(ok(['@beta.example']), true);
  assert.equal(ok(['@BETA.example', 'x@y.example']), true);
  assert.equal(ok(['@example']), false);
  assert.equal(ok(['@sub.beta.example']), false);
  assert.equal(ok(['bob@gmail.com']), false);
  assert.equal(ok(['@gmail.com']), false);
  assert.equal(ok(['xbob@beta.example']), false);
  const out = checkProfile(r.signed, { senders: ['@gmail.com'] });
  assert.deepEqual(out.failed, [{ rule: 'senders', want: ['@gmail.com'], got: ['bob@beta.example'] }]);
  assert.equal(out.record, r.signed.id);
  assert.equal(out.rules, RULES_VERSION);
});

test('an unsigned From never satisfies senders', async () => {
  const { r } = await buildThread();
  // zed@zed.example is in the record as message.from, but no signature covers it
  const out = checkProfile(r.plain, { senders: ['zed@zed.example'] });
  assert.equal(out.ok, false);
  assert.deepEqual(out.failed, [{ rule: 'senders', want: ['zed@zed.example'], got: [] }]);
  // a failing signature does not count either, even though the signed From line is in the record
  const bad = checkProfile(r.failing, { senders: ['bob@beta.example'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failed[0].got, []);
  // and a record whose message.from was edited to a wanted address stays unsatisfied
  const forged = structuredClone(r.plain); forged.message.from = 'ceo@bank.example';
  assert.equal(checkProfile(forged, { senders: ['ceo@bank.example'] }).ok, false);
});

test('a signed From that a signature covers but is for another domain never aligns', async () => {
  const mk = makeDomains(['signer.example']);
  const m = await mk('signer.example', { from: 'ceo@bank.example' });   // third-party signature over someone else's From
  const mp = new Mailproof({ trailDir: makeTmpDir('mp-prof-'), resolver: m.resolver, worker: { size: 0 }, now: () => T0 });
  const { record } = await mp.record(m.raw, { direction: 'in' });
  const out = checkProfile(record, { senders: ['ceo@bank.example'], checks: { dkimAligned: true } });
  assert.deepEqual(rules(out), ['senders', 'checks.dkimAligned']);
});

test('checks: dkimAligned from the portable re-check; dmarc, spf, arc from the live facts at capture', async () => {
  const { r } = await buildThread();
  assert.equal(checkProfile(r.signed, { checks: { dkimAligned: true, dmarc: true } }).ok, true);
  assert.equal(checkProfile(r.signed, { checks: { dkimAligned: false, spf: false, arc: false } }).ok, true);   // false = not required
  // no envelope at capture: SPF was not decided; no ARC chain: none
  assert.deepEqual(checkProfile(r.signed, { checks: { spf: true, arc: true } }).failed, [
    { rule: 'checks.spf', want: 'pass', got: 'none' }, { rule: 'checks.arc', want: 'pass', got: 'none' }]);
  // a signature that does not verify
  assert.deepEqual(checkProfile(r.failing, { checks: { dkimAligned: true } }).failed, [{ rule: 'checks.dkimAligned', want: 'pass', got: 'fail' }]);
  // DMARC recorded as fail
  const f = structuredClone(r.signed); f.verdicts.live.dmarc.result = 'fail';
  assert.deepEqual(checkProfile(f, { checks: { dmarc: true } }).failed, [{ rule: 'checks.dmarc', want: 'pass', got: 'fail' }]);
  // spf/arc recorded as pass
  const g = structuredClone(r.signed); g.verdicts.live.spf = { result: 'pass' }; g.verdicts.live.arc = { result: 'pass', sealers: [] };
  assert.equal(checkProfile(g, { checks: { spf: true, arc: true } }).ok, true);
});

test('link: strongest by default, or the link to one named parent; all failures are listed', async () => {
  const { r } = await buildThread();
  assert.equal(checkProfile(r.signed, { link: ['signed'] }).ok, true);
  assert.deepEqual(checkProfile(r.unsigned, { link: ['signed'] }).failed, [{ rule: 'link', want: ['signed'], got: 'unsigned' }]);
  assert.equal(checkProfile(r.unsigned, { link: ['signed', 'unsigned'] }).ok, true);
  assert.deepEqual(checkProfile(r.failing, { link: ['signed'] }).failed, [{ rule: 'link', want: ['signed'], got: 'unsigned' }]);   // present, but only under a failing signature
  assert.deepEqual(checkProfile(r.plain, { link: ['signed', 'unsigned'] }).failed, [{ rule: 'link', want: ['signed', 'unsigned'], got: 'none' }]);
  assert.equal(checkProfile(r.plain, { link: ['none'] }).ok, true);
  // the request this answer must be tied to
  assert.equal(checkProfile(r.signed, { link: ['signed'] }, { parent: REQ }).ok, true);
  assert.deepEqual(checkProfile(r.signed, { link: ['signed'] }, { parent: '<other@owner.example>' }).failed, [{ rule: 'link', want: ['signed'], got: 'none' }]);
  // everything wrong at once: every rule is reported
  const out = checkProfile(r.plain, { senders: ['a@b.example'], checks: { dkimAligned: true, dmarc: true }, body: 'proven', link: ['signed'] });
  assert.deepEqual(rules(out), ['senders', 'checks.dkimAligned', 'checks.dmarc', 'body', 'link']);
});

test('body: proven / partial / any from body_status', async () => {
  const { r } = await buildThread();
  assert.equal(r.signed.body_status, 'matched');
  assert.equal(checkProfile(r.signed, { body: 'proven' }).ok, true);
  const p = structuredClone(r.signed); p.body_status = 'partial';
  assert.equal(checkProfile(p, { body: 'proven' }).ok, false);
  assert.equal(checkProfile(p, { body: 'partial' }).ok, true);
});

test('audit replay: the same record, profile and time give the same answer, whenever it runs', async () => {
  const { r } = await buildThread();
  const profile = { senders: ['@beta.example'], checks: { dkimAligned: true, dmarc: true }, body: 'proven', link: ['signed'] };
  const first = checkProfile(r.signed, profile, { parent: REQ });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 10 * 365 * 86_400_000;
    assert.deepEqual(checkProfile(JSON.parse(JSON.stringify(r.signed)), profile, { parent: REQ }), first);
    assert.deepEqual(checkProfile(JSON.stringify(r.signed), profile, { parent: REQ }), first);
  } finally { Date.now = realNow; }
  assert.equal(first.ok, true);
  // `at` is honoured: judged before the signature existed, the signature is "from the future" and fails
  const early = checkProfile(r.signed, { checks: { dkimAligned: true } }, { at: new Date(T0.getTime() - 3600_000) });
  assert.deepEqual(early.failed, [{ rule: 'checks.dkimAligned', want: 'pass', got: 'fail' }]);
});

test('mp.checkProfile reads the record by id; unknown id and bad profile', async () => {
  const { mp, r } = await buildThread();
  assert.deepEqual(await mp.checkProfile(r.signed.id, { link: ['signed'] }, { parent: REQ }), checkProfile(r.signed, { link: ['signed'] }, { parent: REQ }));
  assert.equal((await mp.checkProfile(r.unsigned.id, { link: ['signed'] })).ok, false);
  const missing = await mp.checkProfile('0'.repeat(32), {});
  assert.equal(missing.ok, false);
  assert.equal(missing.failed[0].rule, 'record');
  await assert.rejects(() => mp.checkProfile(r.signed.id, { sender: ['x@y.example'] }), (e) => e.code === 'ERR_BAD_PROFILE');
  await assert.rejects(() => mp.checkProfile('0'.repeat(32), 'x'), (e) => e.code === 'ERR_BAD_PROFILE');   // validated even when the record is missing
});

// ---- proofParts ----

const PDF = Buffer.from('%PDF-1.4 the contract bytes\n'.repeat(30));
async function withAttachment(extra = {}) {
  const mk = makeDomains(['beta.example']);
  const m = await mk('beta.example', { from: 'bob@beta.example', attachment: { filename: 'c.pdf', bytes: PDF }, ...extra });
  const dir = makeTmpDir('mp-parts-');
  const mp = new Mailproof({ trailDir: dir, resolver: stubResolver(m.map), worker: { size: 0 }, now: () => T0, ...(extra.content ? { content: extra.content } : {}) });
  const { record } = await mp.record(m.raw, { direction: 'in' });
  return { mp, dir, record, hex: crypto.createHash('sha256').update(PDF).digest('hex') };
}
const attFile = (dir, hex) => path.join(dir, 'default.content', 'att', hex.slice(0, 2), hex);

test('proofParts: email and attachment are separate results; stored attachment re-hashes to a match', async () => {
  const { mp, record, hex } = await withAttachment();
  const p = await mp.proofParts(record.id);
  assert.deepEqual(p, {
    email: { ok: true, trust: 'verified', body_status: 'matched' },
    attachments: [{ index: 0, filename: 'c.pdf', sha256: `sha256:${hex}`, stored: true, match: true }],
  });
  assert.deepEqual(await mp.proofParts(record), p);   // a record object works too
});

test('proofParts: "email valid, attachment is not the one recorded" (a stored file that was swapped)', async () => {
  const { mp, dir, record, hex } = await withAttachment();
  fs.chmodSync(attFile(dir, hex), 0o600);
  fs.writeFileSync(attFile(dir, hex), Buffer.from('%PDF-1.4 a different contract\n'));
  const p = await mp.proofParts(record.id);
  assert.equal(p.email.ok, true);
  assert.deepEqual(p.attachments[0], { index: 0, filename: 'c.pdf', sha256: `sha256:${hex}`, stored: true, match: false });
  assert.equal(await mp.attachment(hex), null);   // the store itself refuses to hand it out
});

test('proofParts: nothing stored is null, never false (forgotten, attachments off, store off)', async () => {
  const a = await withAttachment();
  await a.mp.forget(a.record.id);
  assert.deepEqual((await a.mp.proofParts(a.record.id)).attachments[0], { index: 0, filename: 'c.pdf', sha256: `sha256:${a.hex}`, stored: false, match: null });
  assert.equal((await a.mp.proofParts(a.record.id)).email.ok, true);
  const b = await withAttachment({ content: { attachments: false } });
  assert.deepEqual((await b.mp.proofParts(b.record.id)).attachments.map((x) => [x.stored, x.match]), [[false, null]]);
  const c = await withAttachment({ content: { store: false } });
  assert.deepEqual((await c.mp.proofParts(c.record.id)).attachments.map((x) => [x.stored, x.match]), [[false, null]]);
});

test('proofParts: no attachments gives an empty list; an unsigned email is not ok; unknown id is null; malformed attachment entries are safe', async () => {
  const { mp, r } = await buildThread();
  assert.deepEqual(await mp.proofParts(r.signed.id), { email: { ok: true, trust: 'verified', body_status: 'matched' }, attachments: [] });
  assert.deepEqual((await mp.proofParts(r.plain.id)).email, { ok: false, trust: 'unverified', body_status: 'not-checked' });
  assert.equal((await mp.proofParts(r.failing.id)).email.ok, false);
  assert.equal(await mp.proofParts('0'.repeat(32)), null);
  assert.equal(await mp.proofParts(undefined), null);
  const odd = { ...structuredClone(r.signed), attachments: [null, 'x', { sha256: 5 }, { filename: 'a', sha256: 'sha256:zz' }] };
  assert.deepEqual((await mp.proofParts(odd)).attachments.map((x) => [x.stored, x.match]), [[false, null], [false, null], [false, null], [false, null]]);
});
