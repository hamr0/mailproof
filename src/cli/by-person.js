// The address-first views (SPEC B11.5a): `show <address|Message-ID>`, `verify <address|Message-ID>` and `people`. Each is a
// thin layer over `list` / `copies` / `get` / `verify` / `counterparties`; the resolver and the record helpers are in target.js.

import { UsageError, EX_OK, EX_ERR, EX_NO } from './errors.js';
import { parseDate, parseLimit } from './parse.js';
import { print, warn, printJson } from './session.js';
import { printable as p } from './printable.js';
import { gather, render, whyText, whyNot } from './detail.js';
import { styleOf } from './style.js';
import { targetRecords, factsOfRecord, minute } from './target.js';

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */
/** @typedef {import('./target.js').Target} Target */

/** @param {string} s @returns {string} */
const short = (s) => p(s.slice(0, 12));

/**
 * `--after`, `--before`, `--limit` (and `--all`) of an address or Message-ID target.
 * @param {Args} a
 * @param {number} defLimit  Default for `--limit` (0 = all).
 */
function rangeFlags(a, defLimit) {
  const v = a.values;
  const after = v.after === undefined ? undefined : parseDate(v.after, '--after');
  const before = v.before === undefined ? undefined : parseDate(v.before, '--before');
  if (after && before && after >= before) throw new UsageError('--after must be earlier than --before');
  return { after, before, limit: v.limit === undefined ? defLimit : parseLimit(v.limit, '--limit') };
}

/** @param {Target} t @returns {string} */
const label = (t) => (t.kind === 'address' ? `the address ${p(t.value)}` : `Message-ID ${p(t.value)}`);

/** @param {Target} t @returns {string} */
const nothing = (t) => (t.kind === 'address' ? `no email with ${p(t.value)} in this trail` : `no email with Message-ID ${p(t.value)} in this trail`);

/**
 * `show` for an address or a Message-ID: one compact block per record, newest first.
 * @param {Args} a @param {Ctx} ctx @param {import('./session.js').Session['mp']} mp @param {import('./session.js').Session['account']} account @param {Target} t
 * @returns {Promise<number>}
 */
export async function showMany(a, ctx, mp, account, t) {
  if (a.values.raw) throw new UsageError('--raw needs one record id (an address can name many emails)');
  const f = rangeFlags(a, 50);
  const { records, total } = await targetRecords(mp, t, f);
  if (!total) { warn(ctx, `mailproof: ${nothing(t)}`); return EX_ERR; }
  const facts = [];
  for (const r of records) facts.push(await gather(mp, account, r));
  if (a.values.json) {
    printJson(ctx, { target: t, total, shown: records.length, records: facts.map((x, i) => {
      const { body, seal_data: seal, ...rest } = x;
      return { ...factsOfRecord(records[i]), seal: x.seal, facts: { ...rest, body: { stored: body.stored, source: body.source, ...(a.values.full ? { text: body.text } : {}) } }, record: records[i] };
    }) });
    return EX_OK;
  }
  const more = total - records.length;
  const st = styleOf(ctx);
  const now = (ctx.deps.now ?? (() => new Date()))();
  print(ctx, `${total} email${total === 1 ? '' : 's'} with ${label(t)}${more ? `; showing the newest ${records.length}, ${more} more (--limit 0 for all, or narrow with --after/--before)` : ''}`);
  facts.forEach((x, i) => {
    print(ctx, '');
    print(ctx, st.cyan(`#${i + 1} of ${records.length}`));
    for (const l of render(x, { compact: true, full: Boolean(a.values.full), fullHashes: Boolean(a.values.full), st, now })) print(ctx, l);
  });
  return EX_OK;
}

/**
 * Why a re-check said no, in a few words.
 * @param {Awaited<ReturnType<import('./session.js').Session['mp']['verify']>>} v
 * @returns {string}
 */
function reasonOf(v) {
  if (v.error) return v.error;
  if (!v.signatures.length) return 'unsigned';
  const bad = v.signatures.find((s) => !s.ok);
  return bad ? `${bad.d ?? '-'}: ${bad.why ?? bad.reason ?? 'does not verify'}` : `trust ${v.trust}`;
}

/**
 * `verify` for an address or a Message-ID: re-check each record offline. Exit 0 only when every RECEIVED record verifies;
 * a sent copy is reported and counted apart (providers normally keep Sent copies unsigned, F3) unless `--all`.
 * @param {Args} a @param {Ctx} ctx @param {import('./session.js').Session['mp']} mp @param {Target} t @param {Date | undefined} at
 * @returns {Promise<number>}
 */
export async function verifyMany(a, ctx, mp, t, at) {
  const f = rangeFlags(a, 0);   // verify checks everything by default: a partial check with exit 0 would mislead
  const all = Boolean(a.values.all);
  const { records, total } = await targetRecords(mp, t, f);
  if (!total) { warn(ctx, `mailproof: ${nothing(t)}`); return EX_ERR; }
  const rows = [];
  for (const r of records) {
    const v = await mp.verify(r, at ? { at } : undefined);
    const counted = all || r.direction !== 'out';
    rows.push({ id: r.id, captured: r.captured, direction: r.direction, ok: v.ok, trust: v.trust, reason: v.ok ? null : reasonOf(v), counted, subject: factsOfRecord(r).subject, why: v.ok ? null : whyNot(r, v) });
  }
  const tally = (/** @type {string} */ dir) => {
    const x = rows.filter((r) => r.direction === dir);
    return { verified: x.filter((r) => r.ok).length, failed: x.filter((r) => !r.ok).length };
  };
  const inbound = tally('in');
  const outbound = tally('out');
  const failedCounted = rows.filter((r) => r.counted && !r.ok).length;
  const checkedCounted = rows.filter((r) => r.counted).length;
  const ok = checkedCounted > 0 && failedCounted === 0;
  const code = ok ? EX_OK : EX_NO;
  if (a.values.json) {
    printJson(ctx, { target: t, ok, total, checked: rows.length, inbound, outbound, all, results: rows.map(({ subject: _s, why: _w, ...r }) => r) });
    return code;
  }
  const st = styleOf(ctx);
  const { sym } = st;
  print(ctx, `${rows.length} of ${total} email${total === 1 ? '' : 's'} with ${label(t)} re-checked offline${at ? ` as of ${p(at.toISOString())}` : ''}`);
  for (const r of rows) {
    const dir = r.direction === 'out' ? 'sent    ' : 'received';
    const verdict = r.ok ? st.green(`${sym.ok} OK    `) : st.red(`${sym.bad} NOT OK`);
    const trust = p(r.trust).padEnd(10);
    const subject = r.subject === null ? st.dim('(no signed subject)') : p(r.subject, { max: 80 });
    print(ctx, `${minute(r.captured)}  ${dir}  ${verdict}  ${r.ok ? trust : st.yellow(trust)}  ${subject}${r.counted ? '' : st.dim('  (sent copy, not counted)')}`);
    if (!r.ok && r.why) print(ctx, `   ${st.dim('why:')} ${whyText(st, r.why)}`);
  }
  print(ctx, '');
  print(ctx, `${st.dim('received:')} ${inbound.verified ? st.green(`${inbound.verified} verified`) : `${inbound.verified} verified`}, ${inbound.failed ? st.red(`${inbound.failed} not`) : `${inbound.failed} not`}`);
  if (outbound.verified + outbound.failed) {
    print(ctx, `${st.dim('sent:')} ${outbound.verified} verified, ${outbound.failed} not${all ? '' : ' (not counted: providers normally keep Sent copies unsigned; --all counts them)'}`);
  }
  const badge = ok ? st.badge('green', `${sym.ok} VERIFIED`) : st.badge('red', `${sym.bad} NOT VERIFIED`);
  if (checkedCounted === 0) print(ctx, `${badge}  nothing to verify: no received email names this address (use --all to count sent copies)`);
  else {
    const noun = all ? 'email' : 'received email';
    const n = checkedCounted;
    const bad = failedCounted;
    print(ctx, `${badge}  ${ok ? (n === 1 ? `the ${noun} verifies` : `all ${n} ${noun}s verify`) : (bad === 1 ? `1 ${noun} does not verify` : `${bad} ${noun}s do not verify`)}`);
  }
  return code;
}

/**
 * `people`: every address the trail has seen, with its emails, its verified received emails, first and last capture.
 * @param {Args} a @param {Ctx} ctx @param {import('./session.js').Session} s
 * @returns {Promise<number>}
 */
export async function peopleRun(a, ctx, s) {
  const limit = a.values.limit === undefined ? 50 : parseLimit(a.values.limit, '--limit');
  const me = String(s.account.user ?? '').trim().toLowerCase();
  const rows = await s.mp.counterparties(limit > 0 ? { limit } : {});
  const people = [];
  for (const r of rows) people.push({ address: r.address, emails: r.records, verified: r.verified, first: r.first, last: r.last, you: r.address === me });
  if (a.values.json) { printJson(ctx, people); return EX_OK; }
  if (!people.length) { print(ctx, 'no emails recorded'); return EX_OK; }
  const st = styleOf(ctx);
  // a mark per address: verified (at least one received email verifies), not verified (received emails, none verifies) or sent only (the
  // trail holds only copies you sent). One cached index read per unverified address; no DNS, nothing else.
  /** @type {string[]} */
  const marks = [];
  for (const x of people) {
    if (x.verified > 0) { marks.push(st.green(st.sym.ok)); continue; }
    const got = await s.mp.list({ with: x.address, direction: 'in', limit: 1 });
    marks.push(got.length ? st.red(st.sym.bad) : st.dim('sent only'));
  }
  const YOU = ' (you)';
  const tail = 2 + 6 + 2 + 8 + 2 + 10 + 2 + 9;
  const w = Math.max(7, Math.min(Math.max(...people.map((x) => x.address.length + (x.you ? YOU.length : 0))), st.width - tail));
  print(ctx, st.dim(`${'address'.padEnd(w)}  ${'emails'.padStart(6)}  ${'verified'.padStart(8)}  last`));
  people.forEach((x, i) => {
    const addr = st.fit(p(x.address), x.you ? w - YOU.length : w);
    const used = [...addr].length + (x.you ? YOU.length : 0);
    const ver = String(x.verified).padStart(8);
    print(ctx, `${addr}${x.you ? st.dim(YOU) : ''}${' '.repeat(Math.max(0, w - used))}  ${String(x.emails).padStart(6)}  ${x.verified ? st.green(ver) : x.you ? st.dim(ver) : ver}  ${x.last.slice(0, 10)}  ${marks[i]}`);
  });
  return EX_OK;
}
