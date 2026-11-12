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

/** @typedef {import('./session.js').Ctx} Ctx */
/** @typedef {import('./session.js').Args} Args */

/** @param {Date} d @returns {string} `20261112-093000` (UTC). */
const compact = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/** @param {number} n @returns {string} */
const size = (n) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

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

/** @param {Args} a @param {Ctx} ctx @returns {Promise<number>} */
export async function exportCmd(a, ctx) {
  const v = a.values;
  if (v.with === undefined) throw new UsageError('export needs --with <a,b,...> (the exact addresses to export the exchange with)');
  const addrs = String(v.with).split(',').map((x) => x.trim()).filter(Boolean).map((x) => parseAddress(x, '--with'));
  if (!addrs.length) throw new UsageError('--with needs at least one address');
  const after = v.after === undefined ? undefined : parseDate(v.after, '--after');
  const before = v.before === undefined ? undefined : parseDate(v.before, '--before');
  const tar = v.tar === true;
  return withAccount(a, ctx, async ({ mp, account }) => {
    const now = (ctx.deps.now ?? (() => new Date()))();
    const out = v.out !== undefined ? String(v.out) : defaultBundleOut(account.name, now, tar, ctx.env);
    await ensureDefaultDir(out, ctx.env, 'exports');
    const r = await mp.export({ with: addrs, ...(after ? { after } : {}), ...(before ? { before } : {}), out, tar });
    const behind = r.seals.pending + r.seals.unstamped + r.seals.unsealed;
    if (v.json) printJson(ctx, r);
    else {
      const st = styleOf(ctx);
      const n = (/** @type {number} */ v, /** @type {string} */ word) => (v > 0 ? st.yellow(`${v} ${word}`) : `${v} ${word}`);
      print(ctx, `${st.green(st.sym.ok)} wrote ${st.link(p(tilde(r.out, ctx.env)), fileUrl(path.resolve(r.out)))} (${r.records} records, ${r.replies} replies, ${r.keys} keys, ${r.manifests} manifests, ${size(r.bytes)})`);
      print(ctx, `${st.dim('bundle sha256')} ${r.bundle_sha256}  ${st.dim(`(tell the recipient this out of band; they can run: mailproof verify-bundle --expect ${r.bundle_sha256} <dir>)`)}`);
      print(ctx, `${st.dim('seals:')} ${r.seals.anchored} anchored, ${n(r.seals.pending, 'pending')}, ${n(r.seals.unstamped, 'unstamped')}, ${n(r.seals.unsealed, 'unsealed')}`);
      print(ctx, `${st.dim('raw emails still stored:')} ${r.content.stored} of ${r.records}`);
    }
    if (behind > 0) warn(ctx, `mailproof: ${behind} of ${r.records} records are not anchored yet (pending, unstamped or unsealed): run \`mailproof stamp\` (it stamps and upgrades) and export again`);
    return EX_OK;
  });
}

/** @param {import('../proof/bundle-verify.js').BundleSeal} s @returns {string} */
const sealText = (s) => `${s.state}${s.block !== undefined ? ` (block ${s.block})` : ''}`;

/**
 * The text report of a bundle check (SPEC B13.3.5): the verdict line, the counts, what was not checked, one line per record, the
 * failures of each check, then three fixed sentences. Every string from the bundle passes through printable().
 * @param {import('../proof/bundle-verify.js').BundleResult} r
 * @param {import('./style.js').Style} [st]
 * @returns {string}
 */
export function bundleText(r, st = makeStyle()) {
  const c = r.counts;
  /** @type {string[]} */
  const out = [];
  out.push(`${r.ok ? st.green('OK') : st.red(`FAILED: ${r.failed.map((x) => p(x)).join(', ')}`)}  ${c.records} records (${c.verified} verified, ${c.unverified} unverified); seals: ${c.anchored} anchored, ${c.pending} pending, ${c.unstamped} unstamped, ${c.unsealed} unsealed, ${c.unchecked} unchecked, ${c.bad} bad`);
  if (r.ots === 'absent') out.push(st.yellow(`seals NOT checked: ots not installed (install opentimestamps-client)`));
  else if (r.ots === 'off') out.push('seals NOT checked: ots is off (MAILPROOF_OTS=off)');
  else if (r.ots === 'out of time') out.push('seals NOT fully checked: the time budget for ots ran out (the rest are unchecked)');
  for (const x of r.records) {
    const first = x.problems[0];
    out.push(`${p(x.id.slice(0, 12))}  ${p(x.captured ?? '-')}  ${p(x.direction ?? '-').padEnd(3)}  ${x.trust === 'verified' ? st.green(x.trust) : st.yellow(x.trust)}  seal ${sealText(x.seal)}${first ? `  -- ${p(first, { max: 200 })}` : ''}`);
  }
  const by = new Map();
  for (const x of r.problems) { const l = by.get(x.check) ?? []; l.push(x); by.set(x.check, l); }
  for (const [check, list] of by) {
    out.push(`${p(check)}:`);
    for (const x of list.slice(0, 50)) out.push(`  ${x.id ? `${p(x.id.slice(0, 12))}: ` : ''}${p(x.why, { max: 300 })}`);
    if (list.length > 50) out.push(`  ... and ${list.length - 50} more`);
  }
  out.push('This bundle does not prove completeness: the owner chose which emails to include.');
  out.push('"anchored" means the proof is for these bytes and carries a Bitcoin block attestation; the block is not checked against a Bitcoin node (run `ots verify` for that).');
  out.push('"captured" is the owner\'s clock; only the seal bounds it ("no later than").');
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
