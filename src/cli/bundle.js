// `export` and `verify-bundle` (SPEC B13.2.9, B13.3): thin layers over `Mailproof#export` and `verifyBundle`. `export` is account-scoped;
// `verify-bundle` is account-free (it needs no config: the recipient has none) and loads the verifier lazily, so nothing of the trail,
// the index (the SQLite add-on) or git is needed to run it.

import { UsageError, EX_OK, EX_NO } from './errors.js';
import { parseDate, parseAddress } from './parse.js';
import { withAccount, print, warn, printJson } from './session.js';
import { otsOptionFromEnv } from './secrets.js';
import path from 'node:path';
import { printable as p } from './printable.js';
import { styleOf, makeStyle, fileUrl } from './style.js';
import { tilde, userDir, ensureDefaultDir } from './paths.js';
import { count, humanSize, wrap } from './words.js';
import { pageLines } from './rows.js';
import { sealPhrase } from './seal.js';

/** The most emails the export preview lists as rows (the count is always complete). */
const PREVIEW_ROWS = 5;

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

/** @param {Date} d @returns {string} `20261112-093000` (UTC). */
const compact = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/**
 * The name of a default export (a directory, or a .tar file with `tar`).
 * @param {string} account @param {Date} now @param {boolean} tar @returns {string}
 */
export const bundleName = (account, now, tar) => `mailproof-bundle-${account}-${compact(now)}${tar ? '.tar' : ''}`;

/**
 * The default `out` (SPEC B13.2.7, B11.2a): `~/mailproof/exports/<name>`, absolute under $HOME, never relative to the current directory.
 * @param {string} account @param {Date} now @param {boolean} tar @param {Record<string, string | undefined>} env @returns {string}
 */
export const defaultBundleOut = (account, now, tar, env) => path.join(userDir(env, 'exports'), bundleName(account, now, tar));

/** What a bundle reveals, in two short lines (the preview of `export`, and the same words as the MCP preview's disclosure). */
const REVEALS = ['The bundle shows these emails\' addresses and subjects; your other mail appears only as hashes.', 'No bodies or attachments are copied. It does not prove that no other email exists.'];

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function exportCmd(a, ctx) {
  const v = a.values;
  if (v.with === undefined) throw new UsageError('export needs --with <a,b,...> (the exact addresses to export the exchange with)');
  const addrs = String(v.with).split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseAddress(x, '--with'));
  if (!addrs.length) throw new UsageError('--with needs at least one address');
  const after = v.after === undefined ? undefined : parseDate(v.after, '--after');
  const before = v.before === undefined ? undefined : parseDate(v.before, '--before');
  const tar = v.tar === true;
  const dry = v['dry-run'] === true;
  return withAccount(a, ctx, async ({ mp, account }) => {
    const now = (ctx.deps.now ?? (() => new Date()))();
    const out = v.out !== undefined ? String(v.out) : defaultBundleOut(account.name, now, tar, ctx.env);
    await ensureDefaultDir(out, ctx.env, 'exports');   // also for the preview: the library checks the folder exists
    const r = await mp.export({ with: addrs, ...(after ? { after } : {}), ...(before ? { before } : {}), out, tar, ...(dry ? { dryRun: true } : {}) });
    const behind = r.seals.pending + r.seals.unstamped + r.seals.unsealed;
    const st = styleOf(ctx);
    if (v.json) printJson(ctx, r);
    else if (dry) {
      // the preview (SPEC B13.2.9): what would be written, as browse rows, and what it reveals; nothing is written
      const sel = r.selection ?? [];
      print(ctx, `${sel.length ? 'This would export' : 'Nothing to export:'} ${count(r.records, 'email')} with ${addrs.map((x) => p(x)).join(', ')}${after || before ? ` (${after ? `from ${after.toISOString().slice(0, 10)}` : ''}${after && before ? ' ' : ''}${before ? `before ${before.toISOString().slice(0, 10)}` : ''})` : ''}`);
      if (sel.length) {
        const shown = sel.slice(-PREVIEW_ROWS).reverse();   // the newest few, newest first, as the list shows them
        const facts = (await Promise.all(shown.map((x) => mp.describe(x.id)))).flatMap((d) => d.records);
        for (const l of pageLines({ st, now: () => now }, facts.map((f) => ({ facts: f })), 1)) print(ctx, l);
        if (sel.length > shown.length) print(ctx, st.dim(`and ${sel.length - shown.length} older`));
        print(ctx, '');
        for (const l of REVEALS) print(ctx, l);
        if (behind > 0) print(ctx, st.yellow(`${st.sym.warn} ${count(behind, 'record')} not anchored yet: run seal first for a stronger proof`));
        print(ctx, st.dim('nothing is written yet'));
      }
    } else {
      const n = (/** @type {number} */ c, /** @type {string} */ word) => (c > 0 ? st.yellow(`${c} ${word}`) : `${c} ${word}`);
      print(ctx, `${st.green(st.sym.ok)} saved to ${st.link(p(tilde(r.out, ctx.env)), fileUrl(path.resolve(r.out)))}`);
      print(ctx, `  ${count(r.records, 'record')}, ${count(r.replies, 'reply', 'replies')}, ${count(r.keys, 'key')}, ${count(r.manifests, 'manifest')}, ${humanSize(r.bytes)}`);
      print(ctx, `  ${st.dim('seals:')} ${r.seals.anchored} anchored, ${n(r.seals.pending, 'pending')}, ${n(r.seals.unstamped, 'unstamped')}, ${n(r.seals.unsealed, 'unsealed')}`);
      print(ctx, `  ${st.dim('raw emails still stored:')} ${r.content.stored} of ${r.records}`);
      print(ctx, '');
      print(ctx, `${st.dim('sha256')} ${r.bundle_sha256}  ${st.dim('(tell the recipient this, by another channel)')}`);
      print(ctx, `${st.dim('they run:')} mailproof verify-bundle --expect ${r.bundle_sha256} ${p(path.basename(r.out))}`);
    }
    if (behind > 0 && !dry) warn(ctx, `mailproof: ${behind} of ${r.records} records are not anchored yet (pending, unstamped or unsealed): run \`mailproof stamp\` (it stamps and upgrades) and export again`);
    return EX_OK;
  });
}

/**
 * A bundle record as the facts a browse row takes (rows.js): the party and subject come from the record's own data (the check result's `from`, `to`,
 * `subject`; the record id stands in when a record has none), the third line is the seal phrase (the received form) and, after it, the first problem.
 * @param {import('../proof/bundle-verify.js').BundleResult['records'][number]} x @param {import('./style.js').Style} st @param {Date} now
 * @returns {import('./rows.js').Facts}
 */
const rowFacts = (x, st, now) => {
  const idParty = [{ address: x.id.slice(0, 12), coverage: 'none' }];
  const addr = (/** @type {string | null} */ a) => (typeof a === 'string' && a !== '' ? [{ address: a, coverage: 'none' }] : idParty);
  const out = x.direction === 'out';
  return /** @type {any} */ ({
    captured: typeof x.captured === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(x.captured) ? x.captured : '1970-01-01T00:00:00.000Z',
    direction: out ? 'out' : 'in', from: out ? [] : addr(x.from), to: out ? addr(x.to) : [], cc: [],
    trust: { live: x.trust }, subject: { value: x.subject, coverage: x.subject_signed ? 'signed' : 'none' },
    reason: sealPhrase(x.seal, now, st.sym.dot, null, true), attachments: [],
  });
};

/**
 * The text report of a bundle check (SPEC B13.3.5): the verdict line, the counts, what was not checked, one two-line row per record (the
 * browse rows), the failures of each check, then three fixed sentences (dim, wrapped). Every string from the bundle passes through printable().
 * @param {import('../proof/bundle-verify.js').BundleResult} r
 * @param {import('./style.js').Style} [st]
 * @returns {string}
 */
export function bundleText(r, st = makeStyle()) {
  const c = r.counts;
  /** @type {string[]} */
  const out = [];
  out.push(`${r.ok ? st.green('OK') : st.red(`FAILED: ${r.failed.map((x) => p(x)).join(', ')}`)}  ${count(c.records, 'record')} (${c.verified} verified, ${c.unverified} unverified); seals: ${c.anchored} anchored, ${c.pending} pending, ${c.unstamped} unstamped, ${c.unsealed} unsealed, ${c.unchecked} unchecked, ${c.bad} bad`);
  if (r.ots === 'absent') out.push(st.yellow(`seals NOT checked: ots not installed (install opentimestamps-client)`));
  else if (r.ots === 'off') out.push('seals NOT checked: ots is off (MAILPROOF_OTS=off)');
  else if (r.ots === 'out of time') out.push('seals NOT fully checked: the time budget for ots ran out (the rest are unchecked)');
  const now = new Date();
  if (r.records.length) out.push(...pageLines({ st, now: () => now }, r.records.map((x) => ({ facts: rowFacts(x, st, now), extra: x.problems[0] })), 1));
  const by = new Map();
  for (const x of r.problems) { const l = by.get(x.check) ?? []; l.push(x); by.set(x.check, l); }
  for (const [check, list] of by) {
    out.push(`${p(check)}:`);
    for (const x of list.slice(0, 50)) out.push(`  ${x.id ? `${p(x.id.slice(0, 12))}: ` : ''}${p(x.why, { max: 300 })}`);
    if (list.length > 50) out.push(`  ... and ${list.length - 50} more`);
  }
  out.push('');
  for (const n of [
    'This bundle does not prove completeness: the owner chose which emails to include.',
    '"anchored" means the proof is for these bytes and carries a Bitcoin block attestation; the block is not checked against a Bitcoin node (run `ots verify` for that).',
    '"captured" is the owner\'s clock; only the seal bounds it ("no later than").',
  ]) for (const l of wrap(n, st.width)) out.push(st.dim(l));
  out.push('');
  out.push(r.ok ? st.badge('green', `${st.sym.ok} VERIFIED`) : st.badge('red', `${st.sym.bad} NOT VERIFIED`));
  return out.join('\n');
}

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function verifyBundleCmd(a, ctx) {
  const dir = a.positionals[0];
  const expect = a.values.expect;
  if (expect !== undefined && !/^[0-9a-fA-F]{64}$/.test(String(expect))) throw new UsageError('--expect must be the 64 hex characters of the bundle\'s sha256');
  const { verifyBundle } = await import('../proof/bundle-verify.js');
  const o = otsOptionFromEnv(ctx.env);
  const r = await verifyBundle(dir, {
    ...(o.otsBin !== undefined ? { ots: o.otsBin } : {}),
    ...(expect !== undefined ? { expect: String(expect) } : {}),
    ...(a.values.strict ? { strict: true } : {}),
  });
  if (a.values.json) printJson(ctx, r); else print(ctx, bundleText(r, styleOf(ctx)));
  return r.ok ? EX_OK : EX_NO;
}
