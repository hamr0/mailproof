// TEST-ONLY. A small trail with a request, replies of every link strength, and unsigned mail, recorded through the
// real Mailproof#record(). Shared by the counterparty and trust-profile tests. NEVER imported from src/.
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail, stubResolver, makeKey } from './proof.js';
import { makeTmpDir } from './tmp.js';

export const T0 = new Date('2026-11-01T10:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);

/** One key per domain, so mails of one domain share the resolver map. */
export function makeDomains(names) {
  const keys = Object.fromEntries(names.map((d) => [d, makeKey('rsa')]));
  return (domain, extra = {}) => signedMail({ domain, selector: 's', signers: [{ domain, selector: 's', alg: 'rsa', key: keys[domain] }], signTime: T0, ...extra });
}

/**
 * Records, in capture order:
 *   req      out  owner -> Bob@Beta.Example, cc carol; Message-ID <req@owner.example>
 *   signed   in   Bob replies, In-Reply-To + References signed           -> link signed
 *   unsigned in   Carol replies, threading and Cc (dave) NOT in h= (Microsoft) -> link unsigned, dave invisible
 *   failing  in   Bob's In-Reply-To is in h= but the Subject was altered      -> signature fails -> link unsigned
 *   grand    in   Alice replies to Bob's reply, signed                    -> a child of `signed`
 *   plain    in   unsigned mail from Zed, no threading                    -> link none
 * @param {{ content?: object }} [opts]
 */
export async function buildThread({ content } = {}) {
  const mk = makeDomains(['owner.example', 'beta.example', 'gamma.example', 'alpha.example']);
  const sign = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references'];
  const m = {
    req: await mk('owner.example', { from: 'Owner <me@owner.example>', to: 'Bob <Bob@Beta.Example>', messageId: '<req@owner.example>', subject: 'Approve?',
      extraHeaders: ['Cc: carol@gamma.example'], headerList: sign }),
    signed: await mk('beta.example', { from: 'Bob@Beta.Example', to: 'me@owner.example', messageId: '<r1@beta.example>', inReplyTo: '<req@owner.example>', references: '<req@owner.example>', headerList: sign }),
    unsigned: await mk('gamma.example', { from: 'carol@gamma.example', to: 'me@owner.example', messageId: '<r2@gamma.example>', inReplyTo: '<req@owner.example>', references: '<req@owner.example>', extraHeaders: ['Cc: dave@delta.example'] }),
    failing: await mk('beta.example', { from: 'Bob@Beta.Example', to: 'me@owner.example', messageId: '<r3@beta.example>', inReplyTo: '<req@owner.example>', headerList: sign }),
    grand: await mk('alpha.example', { from: 'alice@alpha.example', to: 'Bob@Beta.Example', messageId: '<g1@alpha.example>', inReplyTo: '<r1@beta.example>', references: '<req@owner.example> <r1@beta.example>', headerList: sign }),
  };
  // alter the signed Subject of `failing` after signing: its DKIM signature no longer verifies, though it still lists In-Reply-To
  m.failing.raw = Buffer.from(m.failing.raw.toString('binary').replace('Subject: Re: please sign', 'Subject: Re: please sign!'), 'binary');
  if (!m.failing.raw.toString('binary').includes('sign!')) throw new Error('thread-trail: the tamper did not apply');
  const plain = Buffer.from('From: Zed <zed@zed.example>\r\nTo: me@owner.example\r\nMessage-ID: <z1@zed.example>\r\n\r\nhello\r\n');
  const map = {};
  for (const k of Object.keys(m)) Object.assign(map, m[k].map);
  const dir = makeTmpDir('mp-thread-');
  const clock = { t: at(0) };
  const mp = new Mailproof({ trailDir: dir, resolver: stubResolver(map), worker: { size: 0 }, now: () => clock.t, ...(content ? { content } : {}) });
  const rec = async (name, raw, direction, min) => { clock.t = at(min); return (await mp.record(raw, { direction, source: 'test' })).record; };
  const r = {};
  r.req = await rec('req', m.req.raw, 'out', 1);
  r.signed = await rec('signed', m.signed.raw, 'in', 2);
  r.unsigned = await rec('unsigned', m.unsigned.raw, 'in', 3);
  r.failing = await rec('failing', m.failing.raw, 'in', 4);
  r.grand = await rec('grand', m.grand.raw, 'in', 5);
  r.plain = await rec('plain', plain, 'in', 6);
  return { mp, dir, clock, mails: m, r, rec, mk, map };
}
