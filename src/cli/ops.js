// The read and check commands: list, show, verify, replies, check, and the destructive pair forget and prune (SPEC B11.5).
// Each is a thin layer over one library call: it validates the flags, calls the library, prints. The menu calls these
// same functions with an argument vector it built from its prompts.

import { UsageError, EX_OK, EX_ERR, EX_NO, EX_USAGE } from './errors.js';
import { parseDate, parseAddress, parseLimit, parseChoice, resolveId, messageIdOf } from './parse.js';
import { loadProfile } from './config.js';
import { withAccount, print, warn, printJson } from './session.js';
import { printable as p } from './printable.js';

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

/** @param {string} s @returns {string} */
const short = (s) => p(s.slice(0, 12));

/** One-line mail field cut to n code points and made terminal-safe (F28). @param {string} s @param {number} n @returns {string} */
const cut = (s, n) => p(s, { max: n });

/**
 * @param {Args} a
 * @returns {{ limit?: number, direction?: 'in' | 'out', with?: string, role?: 'from' | 'to' | 'cc' | 'reply-to', before?: Date, after?: Date }}
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
    for (const r of rows) print(ctx, `${short(r.id)}  ${p(r.captured.replace(/\.\d+Z$/, 'Z'))}  ${p(r.direction).padEnd(3)}  ${p(r.live)}/${p(r.portable)}  ${p(r.message_id ?? '-')}`);
    return EX_OK;
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function showCmd(a, ctx) {
  if (a.values.raw && a.values.json) throw new UsageError('--raw prints bytes: it cannot be combined with --json');
  return withAccount(a, ctx, async ({ mp }) => {
    const id = await resolveId(a.positionals[0], mp.root);
    if (a.values.raw) {
      const raw = await mp.rawEmail(id);
      if (!raw) { warn(ctx, `mailproof: the content store no longer holds ${short(id)} (expired, forgotten, or never stored)`); return EX_ERR; }
      ctx.stdout.write(raw);
      return EX_OK;
    }
    const rec = await mp.get(id);
    if (!rec) { warn(ctx, `mailproof: no record ${short(id)}`); return EX_ERR; }
    const parts = await mp.proofParts(rec);
    const links = await mp.linked(id);
    if (a.values.json) { printJson(ctx, { record: rec, proof: parts, links }); return EX_OK; }
    const m = rec.message ?? {};
    /** @type {Array<[string, string]>} */
    const rows = [
      ['id', p(rec.id)], ['captured', p(rec.captured)], ['direction', p(`${rec.direction} (${rec.source})`)], ['message-id', p(m.message_id ?? '-')],
      ['from', p(m.from ?? rec.addresses?.find((x) => x.role === 'from')?.address ?? '-')],
      ['copy', p(rec.copy?.kind ?? '-')], ['live', p(rec.verdicts?.live?.trust ?? '-')], ['portable', p(rec.verdicts?.portable?.trust ?? '-')],
      ['re-check', parts ? `${parts.email.ok ? 'ok' : 'not ok'} (${p(parts.email.trust)})` : '-'], ['body', p(rec.body_status ?? '-')],
      ['signatures', String(rec.signatures?.length ?? 0)],
    ];
    for (const r of rows) print(ctx, `${r[0].padEnd(11)} ${r[1]}`);
    for (const x of parts?.attachments ?? []) print(ctx, `attachment   ${p(x.filename ?? '(no name)')}  stored ${x.stored ? 'yes' : 'no'}${x.match === null ? '' : x.match ? '  matches' : '  DIFFERS'}`);
    if (links) {
      for (const par of links.parents) print(ctx, `parent       ${p(par.message_id)}  ${p(par.strength)}${par.id ? `  ${short(par.id)}` : '  (not recorded)'}`);
      for (const c of links.children) print(ctx, `child        ${p(c.message_id ?? '-')}  ${p(c.strength)}  ${short(c.id)}`);
      if (links.more) print(ctx, 'child        ... more');
    }
    return EX_OK;
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function verifyCmd(a, ctx) {
  const at = a.values.at === undefined ? undefined : parseDate(a.values.at, '--at');
  return withAccount(a, ctx, async ({ mp }) => {
    const id = await resolveId(a.positionals[0], mp.root);
    const rec = await mp.get(id);
    if (!rec) { warn(ctx, `mailproof: no record ${short(id)}`); return EX_ERR; }
    const v = await mp.verify(rec, at ? { at } : undefined);
    if (a.values.json) { printJson(ctx, { id, ...v }); return v.ok ? EX_OK : EX_NO; }
    print(ctx, `${v.ok ? 'ok' : 'NOT OK'}  ${p(v.trust)}  basis ${p(v.basis)}  at ${p(v.at ?? '-')}  rules ${p(v.engine.rules)}`);
    for (const s of v.signatures) print(ctx, `  ${p(s.d ?? '-')}  ${p(s.s ?? '')}  ${s.ok ? 'verifies' : `fails: ${p(s.why ?? s.reason ?? 'unknown')}`}`);
    if (v.error) print(ctx, `  ${p(v.error)}`);
    return v.ok ? EX_OK : EX_NO;
  });
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function repliesCmd(a, ctx) {
  const messageId = messageIdOf(a.positionals[0]);
  return withAccount(a, ctx, async ({ mp }) => {
    const rows = await mp.replyFacts({ messageId });
    if (a.values.json) { printJson(ctx, rows); return EX_OK; }
    if (!rows.length) { print(ctx, 'no replies recorded'); return EX_OK; }
    for (const r of rows) {
      print(ctx, `${p(r.captured)}  ${p(r.from)}  dkim-aligned ${p(r.fromDkimAligned)}  link ${p(r.link)}  ${p(r.live)}/${p(r.portable)}  body ${p(r.bodyProven)}`);
      print(ctx, `  ${r.firstLine ? cut(r.firstLine, 100) : '(no text stored)'}  [${short(r.recordId)}]`);
    }
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
    print(ctx, r.ok ? 'pass' : 'FAIL');
    for (const f of r.failed) print(ctx, `  ${p(f.rule)}: wanted ${p(JSON.stringify(f.want))}, got ${p(JSON.stringify(f.got))}`);
    return r.ok ? EX_OK : EX_NO;
  });
}

const MORE = (/** @type {number} */ n) => `and ${n} more`;

/**
 * Print the dry-run summary of `forget` (B11.5): the records the same filters name, and how many have a stored raw email.
 * @param {Ctx} ctx
 * @param {import('../index.js').Mailproof} mp
 * @param {string[] | null} ids
 * @param {ReturnType<typeof listFilters>} f
 * @returns {Promise<{ ids: string[], stored: number }>}
 */
async function forgetSummary(ctx, mp, ids, f) {
  const named = ids ?? (await mp.list({ with: f.with, before: f.before, after: f.after })).map((r) => r.id);
  let stored = 0;
  for (const id of named) if (await mp.rawEmail(id)) stored++;
  return { ids: named, stored };
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
    const sum = await forgetSummary(ctx, mp, ids, f);
    const lines = [
      `forget on account ${p(account.name)}: ${sum.ids.length} record(s), ${sum.stored} with a stored raw email (attachment files no other stored email needs go too). Proofs stay.`,
      ...sum.ids.slice(0, 20).map((i) => `  ${short(i)}`),
      ...(sum.ids.length > 20 ? [`  ${MORE(sum.ids.length - 20)}`] : []),
    ];
    if (v['dry-run']) {
      if (v.json) printJson(ctx, { dryRun: true, records: sum.ids, stored: sum.stored }); else print(ctx, lines.join('\n'));
      return EX_OK;
    }
    if (!v.yes) { warn(ctx, `${lines.join('\n')}\nadd --yes to proceed`); return EX_USAGE; }
    if (!v.json) print(ctx, lines.join('\n'));
    const res = await mp.forget(ids ?? { with: /** @type {string} */ (f.with), ...(f.before ? { before: f.before } : {}), ...(f.after ? { after: f.after } : {}) });
    if (v.json) printJson(ctx, res); else print(ctx, `forgot ${res.removed} stored email(s) and ${res.attachments} attachment file(s); the proofs are unchanged`);
    return EX_OK;
  });
}

/**
 * @param {import('../proof/prune.js').PruneResult} r
 * @returns {string}
 */
function pruneLines(r) {
  if (r.noop) return `nothing is captured before ${p(r.cutoff)}: nothing to prune`;
  return [
    `${r.dryRun ? 'prune would' : 'prune did'} remove everything captured before ${p(r.cutoff)}`,
    `  records removed ${r.removed}, kept ${r.kept}; reply rows dropped ${r.dropped}`,
    `  stragglers kept although older (${r.stragglers.length}): ${r.stragglers.slice(0, 5).map(short).join(', ') || '-'}${r.stragglers.length > 5 ? ', ...' : ''}`,
    `  the old trail stays as ${p(r.backup ?? '(deleted)')} until you delete it`,
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
      if (v.json) printJson(ctx, plan); else print(ctx, pruneLines(plan));
      return EX_OK;
    }
    if (!v.yes) { warn(ctx, `${pruneLines(plan)}\nadd --yes to proceed`); return EX_USAGE; }
    if (!v.json) print(ctx, pruneLines(plan));
    const res = await mp.prune({ before, ...(v['delete-backup'] ? { deleteBackup: true } : {}) });
    if (v.json) printJson(ctx, res);
    else print(ctx, `pruned: removed ${res.removed}, kept ${res.kept}; new head ${res.head ? short(res.head) : '-'}; content removed ${res.content.removed}${res.backup ? `; backup ${p(res.backup)}` : ''}`);
    return EX_OK;
  });
}
