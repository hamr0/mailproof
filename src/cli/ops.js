// The read and check commands: list, show, verify, replies, check, and the destructive pair forget and prune (SPEC B11.5).
// Each is a thin layer over one library call: it validates the flags, calls the library, prints. The menu calls these
// same functions with an argument vector it built from its prompts.

import { UsageError, EX_OK, EX_ERR, EX_NO, EX_USAGE } from './errors.js';
import { parseDate, parseAddress, parseLimit, parseChoice, resolveId, messageIdOf } from './parse.js';
import { loadProfile } from './profiles.js';
import { withAccount, print, warn, printJson } from './session.js';
import { printable as p } from './printable.js';
import { render, accountFacts, jsonFacts } from './detail.js';
import { dueFor } from './sync-op.js';
import { styleOf } from './style.js';
import { classifyTarget, otherParty, minute } from './target.js';
import { showMany, verifyMany, peopleRun } from './by-person.js';
import { replyLines, pageLines } from './rows.js';
import { ruleLines } from './profile-text.js';
import { count } from './words.js';
import { tilde } from './paths.js';

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

/** @param {string} s @returns {string} */
const short = (s) => p(s.slice(0, 12));

/** One-line mail field cut to n code points and made terminal-safe (F28). @param {string} s @param {number} n @returns {string} */
const cut = (s, n) => p(s, { max: n });

/**
 * @param {Args} a
 * @returns {{ limit?: number, direction?: 'in' | 'out', with?: string, role?: 'from' | 'to' | 'cc' | 'reply-to', subject?: string, before?: Date, after?: Date }}
 */
function listFilters(a) {
  const v = a.values;
  /** @type {ReturnType<typeof listFilters>} */
  const f = {};
  if (v.with !== undefined) f.with = parseAddress(v.with, '--with');
  if (v.role !== undefined) {
    if (f.with === undefined) throw new UsageError('--role needs --with');
    f.role = /** @type {'from' | 'to' | 'cc' | 'reply-to'} */ (parseChoice(v.role, '--role', 'from', 'to', 'cc', 'reply-to'));
  }
  if (v.direction !== undefined) f.direction = /** @type {'in' | 'out'} */ (parseChoice(v.direction, '--direction', 'in', 'out'));
  if (v.subject !== undefined) { if (!v.subject.trim()) throw new UsageError('--subject needs some text'); f.subject = v.subject; }
  if (v.before !== undefined) f.before = parseDate(v.before, '--before');
  if (v.after !== undefined) f.after = parseDate(v.after, '--after');
  return f;
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function listCmd(a, ctx) {
  const f = listFilters(a);
  const limit = a.values.limit === undefined ? 50 : parseLimit(a.values.limit, '--limit');
  return withAccount(a, ctx, async ({ mp }) => {
    const rows = await mp.list({ ...f, ...(limit > 0 ? { limit } : {}) });
    if (a.values.json) { printJson(ctx, rows); return EX_OK; }
    if (!rows.length) { print(ctx, 'no emails recorded'); return EX_OK; }
    // date, in/out, live trust, the other party, subject, short id last (SPEC B11.5): party and subject are the fields of the
    // library's list rows (one definition, SPEC B5); a subject that is only the sender's word is marked `~`. The widths follow the
    // terminal (80 when there is none); everything is cut as plain escaped text first and styled after.
    const st = styleOf(ctx);
    const markOf = (/** @type {string | null} */ live) => (live === 'verified' ? st.green(st.sym.ok.padEnd(2)) : live ? st.yellow(st.sym.warn.padEnd(2)) : '  ');
    const FIXED = 17 + 2 + 3 + 2 + 2 + 1 + 10 + 2 + 2 + 2 + 12;   // date, direction, mark and trust, the gaps, the id
    const rest = Math.max(24, st.width - FIXED);
    const whoW = Math.min(24, Math.max(12, Math.floor(rest * 0.4)));
    const room = Math.max(10, rest - whoW);
    for (const r of rows) {
      const who = st.fit(p(otherParty(r.direction, r.addresses) ?? '-'), whoW).padEnd(whoW);
      const subject = r.subject === null ? '(none recorded)' : r.subjectSource === 'claimed' ? `~ ${r.subject}` : r.subject;
      const live = p(r.live ?? '-').padEnd(10);
      print(ctx, `${minute(r.captured)}  ${p(r.direction).padEnd(3)}  ${markOf(r.live)} ${r.live === 'verified' ? st.green(live) : st.yellow(live)}  ${who}  ${st.fit(p(subject), room).padEnd(room)}  ${st.dim(short(r.id))}`);
    }
    return EX_OK;
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function showCmd(a, ctx) {
  if (a.values.raw && a.values.json) throw new UsageError('--raw prints bytes: it cannot be combined with --json');
  const t = classifyTarget(a.positionals[0]);
  return withAccount(a, ctx, async (s) => {
    const { mp, account } = s;
    if (t.kind !== 'id') return showMany(a, ctx, mp, account, t, s);
    const id = await resolveId(t.value, mp.root);
    if (a.values.raw) {
      const raw = await mp.rawEmail(id);
      if (!raw) { warn(ctx, `mailproof: the content store no longer holds ${short(id)} (expired, forgotten, or never stored)`); return EX_ERR; }
      ctx.stdout.write(raw);
      return EX_OK;
    }
    const { records: [found] } = await mp.describe(id, { full: true });
    if (!found) { warn(ctx, `mailproof: no record ${short(id)}`); return EX_ERR; }
    const f = accountFacts(found, account);
    if (a.values.json) {
      const [record, proof, links] = await Promise.all([mp.get(id), mp.proofParts(id), mp.linked(id)]);
      printJson(ctx, { record, proof, links, seal: f.seal, facts: jsonFacts(f, Boolean(a.values.full)) });
      return EX_OK;
    }
    for (const l of render(f, { fullHashes: Boolean(a.values.full), st: styleOf(ctx), now: (ctx.deps.now ?? (() => new Date()))(), nextDue: await dueFor([f], s) })) print(ctx, l);
    return EX_OK;
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function verifyCmd(a, ctx) {
  const at = a.values.at === undefined ? undefined : parseDate(a.values.at, '--at');
  const t = classifyTarget(a.positionals[0]);
  return withAccount(a, ctx, async ({ mp }) => {
    if (t.kind !== 'id') return verifyMany(a, ctx, mp, t, at);
    const id = await resolveId(t.value, mp.root);
    const rec = await mp.get(id);
    if (!rec) { warn(ctx, `mailproof: no record ${short(id)}`); return EX_ERR; }
    const v = await mp.verify(rec, at ? { at } : undefined);
    if (a.values.json) { printJson(ctx, { id, ...v }); return v.ok ? EX_OK : EX_NO; }
    const st = styleOf(ctx);
    const { sym } = st;
    print(ctx, `${v.ok ? st.green(`${sym.ok} OK`) : st.red(`${sym.bad} NOT OK`)}  ${v.ok ? st.green(p(v.trust)) : st.yellow(p(v.trust))}  basis ${p(v.basis)}  at ${p(v.at ?? '-')}  rules ${st.dim(p(v.engine.rules))}`);
    for (const s of v.signatures) print(ctx, `  ${s.ok ? st.green(sym.ok) : st.red(sym.bad)} ${p(s.d ?? '-')}  ${p(s.s ?? '')}  ${s.ok ? 'verifies' : `fails: ${p(s.why ?? s.reason ?? 'unknown')}`}`);
    if (v.error) print(ctx, `  ${p(v.error)}`);
    print(ctx, v.ok ? st.badge('green', `${sym.ok} VERIFIED`) : st.badge('red', `${sym.bad} NOT VERIFIED`));
    return v.ok ? EX_OK : EX_NO;
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function peopleCmd(a, ctx) {
  return withAccount(a, ctx, (s) => peopleRun(a, ctx, s));
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function repliesCmd(a, ctx) {
  const t = classifyTarget(a.positionals[0]);
  if (t.kind === 'id') throw new UsageError('replies takes an address (bob@example.org) or a Message-ID in angle brackets (<abc@mail.example>), not a record id');
  return withAccount(a, ctx, async ({ mp }) => {
    const rows = await mp.replyFacts(t.kind === 'address' ? { address: t.value } : { messageId: t.value });
    if (a.values.json) { printJson(ctx, rows); return EX_OK; }
    if (!rows.length) { print(ctx, 'no replies recorded'); return EX_OK; }
    // the library's short reason for each reply's record (the one the list rows use), then the shared reply rows
    const reasons = await Promise.all(rows.map(async (r) => (await mp.describe(String(r.recordId))).records[0]?.reason ?? 'no record'));
    for (const l of replyLines({ st: styleOf(ctx), now: ctx.deps.now ?? (() => new Date()) }, rows.map((row, i) => ({ row, reason: reasons[i] })))) print(ctx, l);
    return EX_OK;
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function checkCmd(a, ctx) {
  if (a.values.profile === undefined) throw new UsageError('check needs --profile <file|name>');
  const profile = await loadProfile(a.values.profile, ctx.env);
  const parent = a.values.parent === undefined ? undefined : messageIdOf(a.values.parent);
  return withAccount(a, ctx, async ({ mp }) => {
    const id = await resolveId(a.positionals[0], mp.root);
    const r = await mp.checkProfile(id, /** @type {any} */ (profile), parent ? { parent } : undefined);
    if (a.values.json) { printJson(ctx, { id, ...r }); return r.ok ? EX_OK : EX_NO; }
    // the verdict, then one line per rule the profile names, each ✓ or ✗ with a plain reason (profile-text.js)
    const st = styleOf(ctx);
    print(ctx, r.ok ? `${st.green(st.sym.ok)} pass` : `${st.red(st.sym.bad)} FAIL`);
    for (const l of ruleLines(profile, r.failed)) print(ctx, `  ${l.ok ? st.green(st.sym.ok) : st.red(st.sym.bad)} ${l.text}`);
    return r.ok ? EX_OK : EX_NO;
  });
}

/** The most emails a destructive preview lists as rows (the count is always complete). */
const PREVIEW_ROWS = 5;

/** `2026-08-19`: a date as people write it. @param {string} iso @returns {string} */
const day = (iso) => p(iso.slice(0, 10));

/**
 * The rows of a preview: the newest `PREVIEW_ROWS` of these records as browse rows, and how many more there are.
 * @param {import('../index.js').Mailproof} mp @param {string[]} ids  Newest first. @param {Ctx} ctx @returns {Promise<string[]>}
 */
async function previewRows(mp, ids, ctx) {
  const shown = ids.slice(0, PREVIEW_ROWS);
  const facts = (await Promise.all(shown.map((i) => mp.describe(i)))).flatMap((d) => d.records);
  const st = styleOf(ctx);
  const lines = pageLines({ st, now: ctx.deps.now ?? (() => new Date()) }, facts.map((f) => ({ facts: f })), 1);
  if (ids.length > shown.length) lines.push(st.dim(`and ${ids.length - shown.length} more`));
  return lines;
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function forgetCmd(a, ctx) {
  const v = a.values;
  const f = listFilters(a);
  if (a.positionals.length && v.with !== undefined) throw new UsageError('give record ids or --with, not both');
  if (!a.positionals.length && v.with === undefined) throw new UsageError('forget needs a target: one or more record ids, or --with <address> (there is no "forget everything")');
  if (v.with === undefined && (v.before !== undefined || v.after !== undefined)) throw new UsageError('--before and --after go with --with');
  return withAccount(a, ctx, async ({ mp, account }) => {
    const ids = a.positionals.length ? await Promise.all(a.positionals.map((p) => resolveId(p, mp.root))) : null;
    const target = ids ?? { with: /** @type {string} */ (f.with), ...(f.before ? { before: f.before } : {}), ...(f.after ? { after: f.after } : {}) };
    const plan = await mp.forget(target, { dryRun: true });   // the library's own preview: one definition (SPEC B12.5)
    const sum = { ids: plan.ids ?? [], stored: plan.removed };
    // the preview: the count in plain words, then the emails as browse rows (the menu shows it once, then asks, then runs with --yes)
    const preview = async () => [
      `Forget on account ${p(account.name)}: ${count(sum.ids.length, 'email')}, ${sum.stored} with a stored raw email. Attachment files no other stored email needs go too. The proofs stay.`,
      ...(await previewRows(mp, sum.ids, ctx)),
    ].join('\n');
    if (v['dry-run']) {
      if (v.json) printJson(ctx, plan); else print(ctx, await preview());
      return EX_OK;
    }
    if (!v.yes) { warn(ctx, `${await preview()}\nadd --yes to proceed`); return EX_USAGE; }
    if (!v.json && !ctx.previewed) print(ctx, await preview());
    const res = await mp.forget(target);
    if (v.json) printJson(ctx, res); else print(ctx, `forgot ${count(res.removed, 'stored email')} and ${count(res.attachments, 'attachment file')}; the proofs are unchanged`);
    return EX_OK;
  });
}

/**
 * The preview of a prune in plain words: how many proofs go, over which dates, the newest as browse rows; or that nothing is captured before the date.
 * @param {import('../index.js').Mailproof} mp @param {import('../proof/prune.js').PruneResult} r @param {Ctx} ctx
 * @returns {Promise<string>}
 */
async function pruneText(mp, r, ctx) {
  const st = styleOf(ctx);
  if (r.noop) return `nothing is captured before ${day(r.cutoff)}: nothing to prune`;
  const old = await mp.list({ before: new Date(r.cutoff) });   // newest first
  const span = old.length ? ` (${day(old[old.length - 1].captured)} to ${day(old[0].captured)})` : '';
  return [
    `${r.dryRun ? 'Prune would permanently remove' : 'Prune removes'} ${count(r.removed, 'proof')} captured before ${day(r.cutoff)}${span} and keep ${r.kept}.`,
    ...(await previewRows(mp, old.map((x) => x.id), ctx)),
    ...(r.stragglers.length ? [`${count(r.stragglers.length, 'older email')} stays, because it sits after a newer one: ${r.stragglers.slice(0, 5).map(short).join(', ')}${r.stragglers.length > 5 ? ', ...' : ''}`] : []),
    st.dim(`The old trail stays as ${p(tilde(r.backup ?? '', ctx.env) || '(deleted)')} until you delete it.`),
  ].join('\n');
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function pruneCmd(a, ctx) {
  const v = a.values;
  if (v.before === undefined) throw new UsageError('prune needs --before <date>');
  const before = parseDate(v.before, '--before');
  return withAccount(a, ctx, async ({ mp }) => {
    const plan = await mp.prune({ before, dryRun: true });
    if (plan.noop || v['dry-run']) {
      if (v.json) printJson(ctx, plan); else print(ctx, await pruneText(mp, plan, ctx));
      return EX_OK;
    }
    if (!v.yes) { warn(ctx, `${await pruneText(mp, plan, ctx)}\nadd --yes to proceed`); return EX_USAGE; }
    if (!v.json && !ctx.previewed) print(ctx, await pruneText(mp, plan, ctx));
    const res = await mp.prune({ before, ...(v['delete-backup'] ? { deleteBackup: true } : {}) });
    if (v.json) printJson(ctx, res);
    else print(ctx, `pruned: removed ${count(res.removed, 'proof')}, kept ${res.kept}; new head ${res.head ? short(res.head) : '-'}; content of ${count(res.content.removed, 'email')} removed${res.backup ? `; the old trail is kept as ${p(tilde(res.backup, ctx.env))}` : '; the old trail was deleted'}`);
    return EX_OK;
  });
}
