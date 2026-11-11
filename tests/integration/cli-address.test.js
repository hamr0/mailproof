// Address-first CLI (SPEC B11.5a): show/verify by address, Message-ID or id, the fixed-label show view, people, list columns,
// the id hints, and the menu's People item. Real record() over the thread fixture; IMAP is never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThread } from '../helpers/thread-trail.js';
import { makeWorld, account } from '../helpers/cli.js';
import { classifyTarget } from '../../src/cli/target.js';
import { UsageError } from '../../src/cli/errors.js';
import { LABELS } from '../../src/cli/detail.js';
import { htmlToText, bodyText } from '../../src/proof/body-text.js';

const T = await buildThread();
const longBody = `${Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\r\n')}\r\n`;
T.r.long = await T.rec('long', Buffer.from(`From: Lou <lou@long.example>\r\nTo: me@owner.example\r\nMessage-ID: <l1@long.example>\r\nSubject: long one\r\n\r\n${longBody}`), 'in', 7);
await T.rec('html', Buffer.from('From: hal@html.example\r\nTo: me@owner.example\r\nMessage-ID: <h1@html.example>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><head><style>p{}</style></head><body><p>Hello &amp; welcome</p><p>second<br>line</p></body></html>\r\n'), 'in', 8);
const w = makeWorld({ accounts: { test: account(T.dir) } });
const BOB = 'bob@beta.example';
const id = (n) => T.r[n].id;
const labelsOf = (s) => s.split('\n').filter((l) => /^\S/.test(l)).map((l) => l.slice(0, 12).trim());

test('resolver: <..> is a Message-ID, @ an address, 8-32 hex an id; everything else is refused with the forms', () => {
  assert.deepEqual(classifyTarget('<a@b.c>'), { kind: 'message-id', value: '<a@b.c>' });
  assert.deepEqual(classifyTarget(' Bob@Beta.Example '), { kind: 'address', value: BOB });
  assert.deepEqual(classifyTarget('EA1FDA2A'), { kind: 'id', value: 'ea1fda2a' });
  assert.equal(classifyTarget('a'.repeat(32)).kind, 'id');
  for (const bad of ['ea1fda2', 'hello', '--ea1fda2', '<a b>', 'a'.repeat(33), 'a@b c']) assert.throws(() => classifyTarget(bad), (e) => e instanceof UsageError, bad);
  assert.throws(() => classifyTarget('hello'), /an address .*Message-ID.*record id/);
});

test('show <address>: every record naming it, newest first, each block with the full compact label set', async () => {
  const r = await w.run(['show', BOB]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^4 emails with the address bob@beta\.example$/m);
  assert.deepEqual([...r.stdout.matchAll(/^id +([0-9a-f]{32})$/gm)].map((m) => m[1]), [id('grand'), id('failing'), id('signed'), id('req')], 'newest capture first');
  assert.equal([...r.stdout.matchAll(/^#\d of 4$/gm)].length, 4);
  const blocks = r.stdout.split(/^#\d of 4$/m).slice(1);
  for (const b of blocks) for (const l of ['account', 'direction', 'date', 'captured', 'from', 'to', 'cc', 'reply-to', 'bcc', 'subject', 'trust', 'why', 'body proof', 'body', 'attachments', 'seal', 'message-id', 'id']) assert.ok(new RegExp(`^${l} +\\S`, 'm').test(b), `${l} in ${b}`);
  assert.match(blocks[2], /^account +me@owner\.example \(test\)$/m);
  assert.match(blocks[2], /^direction +received/m);
  assert.match(blocks[2], /^from +Bob@Beta\.Example \(signed\)$/m);
  assert.match(blocks[2], /^subject +Re: please sign \(signed\)$/m);
  assert.match(blocks[2], /^trust +live verified, portable verified; re-check ok \(verified\)$/m);
  assert.match(blocks[2], /^why +N\/A \(it verifies\)$/m);
  assert.match(blocks[3], /^direction +sent/m);
  assert.match(blocks[3], /^cc +carol@gamma\.example \(signed\)$/m);
  assert.match(blocks[1], /^why +.*offline re-check of beta\.example/m, 'the tampered email says why');
});

test('show <address> with a Message-ID, --limit counts the rest, --after/--before narrow, --json is one document', async () => {
  const m = await w.run(['show', '<r1@beta.example>']);
  assert.equal(m.code, 0, m.stderr);
  assert.match(m.stdout, /^1 email with Message-ID <r1@beta\.example>$/m);
  const lim = await w.run(['show', BOB, '--limit', '1']);
  assert.match(lim.stdout, /^4 emails with the address bob@beta\.example; showing the newest 1, 3 more /m);
  const rng = await w.run(['show', BOB, '--after', '2026-11-01T10:02:00Z', '--before', '2026-11-01T10:05:00Z']);
  assert.match(rng.stdout, /^2 emails with/m);
  const j = await w.run(['show', BOB, '--json']);
  const d = JSON.parse(j.stdout);
  assert.equal(j.stdout.trim().split('\n').length, 1);
  assert.deepEqual([d.total, d.shown, d.records.length], [4, 4, 4]);
  assert.equal(d.records[0].record.id, id('grand'));
  assert.ok(!('text' in d.records[0].facts.body), 'no body text in --json without --full');
  const jf = JSON.parse((await w.run(['show', 'lou@long.example', '--json', '--full'])).stdout);
  assert.match(jf.records[0].facts.body.text, /^line 1\nline 2/);
});

test('show <address>: nothing recorded is exit 1 with the message on stderr; --raw needs an id', async () => {
  const n = await w.run(['show', 'nobody@nowhere.example']);
  assert.equal(n.code, 1);
  assert.equal(n.stdout, '');
  assert.match(n.stderr, /no email with nobody@nowhere\.example in this trail/);
  assert.equal((await w.run(['show', '<none@x.example>'])).code, 1);
  assert.equal((await w.run(['show', BOB, '--raw'])).code, 64);
  assert.equal((await w.run(['show', BOB, '--limit', 'x'])).code, 64);
});

test('show <id>: every label, in the fixed order, even for a minimal unsigned record; N/A where absent', async () => {
  const r = await w.run(['show', id('plain')]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(labelsOf(r.stdout), LABELS);
  assert.match(r.stdout, /^cc +N\/A$/m);
  assert.match(r.stdout, /^bcc +N\/A$/m);
  assert.match(r.stdout, /^reply-to +N\/A$/m);
  assert.match(r.stdout, /^attachments +N\/A \(none\)$/m);
  assert.match(r.stdout, /^dkim +N\/A \(no DKIM signature\)$/m);
  assert.match(r.stdout, /^subject +N\/A$/m);
  assert.match(r.stdout, /^from +zed@zed\.example \(not signed\)$/m);
  assert.match(r.stdout, /^why +there is no DKIM signature on this email$/m);
  assert.match(r.stdout, /^body proof +not proven \(not-checked\)$/m);
  assert.match(r.stdout, /^body +\(text\/plain\)\n  hello\n/m);
  assert.match(r.stdout, /^id +[0-9a-f]{32}\n$/m);
  assert.ok(r.stdout.trimEnd().endsWith(`id           ${id('plain')}`));
});

test('show <id>: the full record view lists dkim, dmarc, thread links, children, the body and a prefix works', async () => {
  const r = await w.run(['show', id('signed').slice(0, 10)]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(labelsOf(r.stdout), LABELS);
  assert.match(r.stdout, /^dkim +d=beta\.example s=s a=rsa-sha256 result=pass aligned=yes re-check=ok body=matched key archived=yes$/m);
  assert.match(r.stdout, /^dmarc +pass, policy none, published yes$/m);
  assert.match(r.stdout, /^in-reply-to +<req@owner\.example>, link signed$/m);
  assert.match(r.stdout, /^children +<g1@alpha\.example>  signed  /m);
  assert.match(r.stdout, /^spf +N\/A$/m);
  assert.match(r.stdout, /^trust +live verified, portable verified; rules mp-rules\/1; re-check ok/m);
  assert.match(r.stdout, /^content +raw email stored \(sha256:/m);
  const j = JSON.parse((await w.run(['show', id('signed'), '--json'])).stdout);
  assert.deepEqual(Object.keys(j).sort(), ['facts', 'links', 'proof', 'record', 'seal']);
  assert.equal(j.facts.account.name, 'test');
});

test('show: the body is cut to 10 lines in the multi view (--full shows all), HTML-only mail is rendered as text, an absent body says so', async () => {
  const cut = await w.run(['show', 'lou@long.example']);
  assert.match(cut.stdout, /^  line 10$/m);
  assert.ok(!/^  line 11$/m.test(cut.stdout));
  assert.match(cut.stdout, /^  \.\.\. 5 more lines, use show [0-9a-f]{12} --full$/m);
  assert.match((await w.run(['show', 'lou@long.example', '--full'])).stdout, /^  line 15$/m);
  assert.match((await w.run(['show', T.r.long.id])).stdout, /^  line 15$/m, 'the one-record view is in full');
  const h = await w.run(['show', 'hal@html.example']);
  assert.match(h.stdout, /^body +\(text\/html\)\n  Hello & welcome\n  second\n  line\n/m);
  await T.mp.forget([id('plain')]);
  const gone = await w.run(['show', id('plain')]);
  assert.match(gone.stdout, /^body +N\/A \(not stored: expired, forgotten or the content store is off\)$/m);
  assert.match(gone.stdout, /^content +N\/A \(raw email not stored\)$/m);
  assert.equal((await w.run(['show', id('plain'), '--json'])).code, 0, 'the proof stays');
});

test('htmlToText and bodyText: scripts and styles dropped, entities decoded, never throws', () => {
  assert.equal(htmlToText('<p>a&nbsp;b &#65; &#x42; &bogus;</p><script>x<y</script><!-- c --><div>z</div>'), 'a b A B &bogus;\nz');
  assert.equal(htmlToText('<unterminated'), '<unterminated');
  assert.equal(bodyText(Buffer.from('')).text, '');
  assert.equal(bodyText(Buffer.from('Content-Type: text/plain; format=flowed\r\n\r\nab \r\ncd\r\n')).text, 'ab cd');
});

test('verify <address>: one line per email, exit 2 when a RECEIVED one fails, sent copies counted apart, --all counts them', async () => {
  const r = await w.run(['verify', BOB]);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stdout, /^received: 2 verified, 1 not$/m);
  assert.match(r.stdout, /^sent: 1 verified, 0 not \(not counted/m);
  assert.match(r.stdout, /^1 received email does not verify$/m);
  assert.match(r.stdout, /NOT OK .*offline re-check|NOT OK .*beta\.example/m);
  assert.equal(r.stdout.split('\n').filter((l) => /^2026-/.test(l)).length, 4);
  assert.equal((await w.run(['verify', BOB, '--all'])).code, 2);
  const ok = await w.run(['verify', 'alice@alpha.example']);
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /^the received email verifies$/m);
  const only = await w.run(['verify', BOB, '--before', '2026-11-01T10:01:30Z']);
  assert.equal(only.code, 2, 'only a sent copy: nothing proves anything received');
  assert.match(only.stdout, /nothing to verify: no received email/);
  assert.equal((await w.run(['verify', BOB, '--before', '2026-11-01T10:01:30Z', '--all'])).code, 0, '--all counts the sent copy, which verifies');
  const uns = await w.run(['verify', 'zed@zed.example']);
  assert.equal(uns.code, 2);
  const j = await w.run(['verify', BOB, '--json']);
  const d = JSON.parse(j.stdout);
  assert.deepEqual([d.ok, d.total, d.inbound.verified, d.inbound.failed, d.outbound.verified], [false, 4, 2, 1, 1]);
  assert.equal((await w.run(['verify', 'nobody@nowhere.example'])).code, 1);
  assert.equal((await w.run(['verify', '<r1@beta.example>'])).code, 0);
});

test('verify <id> is unchanged: ok 0, a failing record 2', async () => {
  assert.equal((await w.run(['verify', id('signed')])).code, 0);
  const bad = await w.run(['verify', id('failing')]);
  assert.equal(bad.code, 2);
  assert.match(bad.stdout, /^NOT OK/);
});

test('people: one line per address with emails, received verified, first and last; the account user is marked (you)', async () => {
  const r = await w.run(['people']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^address +emails +verified +first +last$/m);
  assert.match(r.stdout, /^me@owner\.example \(you\) +\d+ +\d+ +2026-11-01 +2026-11-01$/m);
  assert.match(r.stdout, /^bob@beta\.example +4 +2 +2026-11-01 +2026-11-01$/m);
  assert.match(r.stdout, /^zed@zed\.example +1 +0 /m);
  const j = JSON.parse((await w.run(['people', '--json', '--limit', '3'])).stdout);
  assert.equal(j.length, 3);
  assert.deepEqual(Object.keys(j[0]), ['address', 'emails', 'verified', 'first', 'last', 'you']);
  assert.equal((await w.run(['people', '--limit', 'x'])).code, 64);
});

test('list (text): date, in/out, live trust, other party, subject, short id last; --json unchanged', async () => {
  const r = await w.run(['list']);
  const line = r.stdout.split('\n').find((l) => l.includes(id('signed').slice(0, 12)));
  assert.match(line, /^2026-11-01T10:02Z  in   verified +bob@beta\.example +Re: please sign +[0-9a-f]{12}$/);
  const out = r.stdout.split('\n').find((l) => l.includes(id('req').slice(0, 12)));
  assert.match(out, /^2026-11-01T10:01Z  out  .* +bob@beta\.example +Approve\? +[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(JSON.parse((await w.run(['list', '--json'])).stdout)[0]).sort(), ['captured', 'direction', 'id', 'live', 'message_id', 'portable']);
});

test('id hints: a flag-looking or too-short id says ids are positional and shows the address form', async () => {
  for (const argv of [['show', '--ea1fda2'], ['verify', '--ea1fda2a'], ['show', 'ea1fda2'], ['verify', 'ea1fda2']]) {
    const r = await w.run(argv);
    assert.equal(r.code, 64, argv.join(' '));
    assert.match(r.stderr, /ids are positional: mailproof show ea1fda2a \(8\+ characters\), or use an address: mailproof show b@example\.com/);
  }
  const bare = await w.run(['show', 'hello']);
  assert.equal(bare.code, 64);
  assert.match(bare.stderr, /an address \(b@example\.com\), a Message-ID in angle brackets/);
});

test('menu: People lists them, picks one, then Show / Verify run the same code; Show and Verify take an address', async () => {
  const keys = (...l) => `${l.join('\n')}\n`;
  const m = await w.run([], { interactive: true, input: keys('16', 'bob@beta.example', 'verify', '', 'q') });
  assert.match(m.stdout, /bob@beta\.example +4 emails, 2 verified/);
  assert.match(m.stdout, /received: 2 verified, 1 not/);
  const byNumber = await w.run([], { interactive: true, input: keys('16', '1', '', '', 'q') });
  assert.match(byNumber.stdout, /^#1 of /m, 'the default action is show');
  const s = await w.run([], { interactive: true, input: keys('4', BOB, '', 'q') });
  assert.ok(s.stdout.includes((await w.run(['show', BOB])).stdout));
  const ex = await w.run([], { interactive: true, input: keys('16', BOB, 'export', '', '', '/nonexistent-dir/xx', '', 'q') });
  assert.match(ex.stdout, /Write the bundle to/);
});

// ---- owner's real-trail follow-ups: RFC 2047 subjects, "signed" only when a verifying signature covers it, the recorded DNS error ----
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, stubResolver } from '../helpers/proof.js';
import { makeTmpDir } from '../helpers/tmp.js';

const subjB = `=?utf-8?B?${Buffer.from('weekly — stats', 'utf8').toString('base64')}?=`;
const subjQ = '=?utf-8?Q?weekly_=E2=80=94_stats?=';
const dirX = makeTmpDir('mp-cli-addr2-');
const mpX = new Mailproof({ trailDir: dirX, worker: { size: 0 }, now: () => new Date('2026-11-05T10:00:00Z') });
const hdr = ['from', 'to', 'subject', 'date', 'message-id'];
const good = await signedMail({ domain: 'ok.example', from: 'ann@ok.example', to: 'me@owner.example', subject: subjB, headerList: hdr, signTime: new Date('2026-11-05T09:00:00Z') });
const goodQ = await signedMail({ domain: 'ok.example', from: 'ann@ok.example', to: 'me@owner.example', subject: subjQ, headerList: hdr, signTime: new Date('2026-11-05T09:00:00Z') });
const nokey = await signedMail({ domain: 'late.example', selector: 'sel9', from: 'noreply@late.example', to: 'me@owner.example', subject: subjQ, headerList: hdr, signTime: new Date('2026-11-05T09:00:00Z') });
const rGood = (await new Mailproof({ trailDir: dirX, worker: { size: 0 }, resolver: good.resolver, now: () => new Date('2026-11-05T10:01:00Z') }).record(good.raw, { direction: 'in', source: 'test' })).record;
const rGoodQ = (await new Mailproof({ trailDir: dirX, worker: { size: 0 }, resolver: goodQ.resolver, now: () => new Date('2026-11-05T10:02:00Z') }).record(goodQ.raw, { direction: 'in', source: 'test' })).record;
const rNoKey = (await new Mailproof({ trailDir: dirX, worker: { size: 0 }, resolver: stubResolver({}), now: () => new Date('2026-11-05T10:03:00Z') }).record(nokey.raw, { direction: 'in', source: 'test' })).record;
await mpX.close();
const w2 = makeWorld({ accounts: { x: account(dirX) } });

test('RFC 2047 subjects (B and Q, utf-8, an em dash) are decoded in list, show <id>, show <address>', async () => {
  const l = await w2.run(['list']);
  assert.equal([...l.stdout.matchAll(/weekly — stats/g)].length, 3, l.stdout);
  assert.ok(!l.stdout.includes('=?utf-8'), l.stdout);
  for (const rec of [rGood, rGoodQ]) {
    assert.match((await w2.run(['show', rec.id])).stdout, /^subject +weekly — stats \(signed\)$/m);
  }
  const a = await w2.run(['show', 'ann@ok.example']);
  assert.equal([...a.stdout.matchAll(/^subject +weekly — stats \(signed\)$/gm)].length, 2);
});

test('a header covered only by a signature that does not verify is not shown as signed; one rule for every header line', async () => {
  const r = await w2.run(['show', rNoKey.id]);
  assert.match(r.stdout, /^from +noreply@late\.example \(covered by a signature that does not verify\)$/m);
  assert.match(r.stdout, /^to +me@owner\.example \(covered by a signature that does not verify\)$/m);
  assert.match(r.stdout, /^subject +weekly — stats \(covered by a signature that does not verify\)$/m);
  assert.ok(!/\(signed\)/.test(r.stdout.split('\n').filter((l) => /^(from|to|cc|date|subject) /.test(l)).join('\n')), r.stdout);
  const ok = await w2.run(['show', rGood.id]);
  assert.match(ok.stdout, /^from +ann@ok\.example \(signed\)$/m);
  assert.match(ok.stdout, /^cc +N\/A$/m);
  const j = JSON.parse((await w2.run(['show', rNoKey.id, '--json'])).stdout);
  assert.deepEqual([j.facts.from[0].signed, j.facts.from[0].coverage], [false, 'failing']);
  assert.equal(j.record.addresses[0].signed, true, 'the record keeps "some signature covers it"');
  // the unsigned fixture stays "not signed"
  assert.match((await w.run(['show', id('plain')])).stdout, /^from +zed@zed\.example \(not signed\)$/m);
});

test('why: a recorded key-lookup error is stated as the fact, the inference stays only without one', async () => {
  const r = await w2.run(['show', rNoKey.id]);
  const why = /^why +(.*)$/m.exec(r.stdout)[1];
  assert.match(why, /no public key published at sel9\._domainkey\.late\.example at capture \(DNS: /, why);
  assert.ok(!/typically/.test(why), why);
  // no recorded error: a neutral result keeps the hedged inference (a hand-made record)
  const { whyNot } = await import('../../src/cli/detail.js');
  const rec = { v: 2, signatures: [{ tags: { d: 'a.example', s: 'k' }, key_error: null }], verdicts: { live: { trust: 'unverified', dkim: [{ d: 'a.example', s: 'k', result: 'neutral', aligned: false }] } } };
  assert.match(whyNot(rec, { ok: false, signatures: [] }), /DKIM neutral \(typically no public key is published at k\._domainkey\.a\.example\)/);
});
