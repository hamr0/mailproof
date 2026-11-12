// "Check a .eml file" (first-run menu, SPEC B11.4): a one-off look at a saved email with the library's `check()`, nothing recorded, no
// account and no trail needed. Menu-only: the subcommand `check` is the trust-profile check of a recorded id (B11.5), a different thing.
// It asks DNS for the signers' keys (the library's `check` does), and says so.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Mailproof } from '../index.js';
import { EX_OK, EX_NO, UsageError } from './errors.js';
import { expandHome, tilde } from './paths.js';
import { print } from './session.js';
import { printable as p } from './printable.js';
import { styleOf } from './style.js';
import { headerText, claimedHeader } from '../proof/header-text.js';
import { MAX_TOTAL_BYTES } from '../proof/limits.js';

/**
 * The From and Subject a file's header block claims (the first block, unfolded, RFC 2047 words decoded). Nothing here is verified: they are
 * what the file says, shown so a person can tell which email this is.
 * @param {Buffer} raw
 * @returns {{ from: string | null, subject: string | null }}
 */
export function claimedHeaders(raw) {
  const head = raw.subarray(0, 65_536);
  /** @param {string} name @returns {string | null} */
  const get = (name) => { const v = claimedHeader(head, name); return v === null ? null : headerText(v); };
  return { from: get('from'), subject: get('subject') };
}

/**
 * The plain reason an email did not verify (one sentence).
 * @param {{ live: Record<string, any>, portable: Record<string, any>, signatures: number, unsigned: boolean, key_errors: string[] }} c
 * @returns {string}
 */
function whyNot(c) {
  if (c.unsigned || c.signatures === 0) return 'this email has no DKIM signature';
  if (c.key_errors.length) return `a signature's key could not be fetched (${p(c.key_errors[0], { max: 120 })})`;
  const reason = c.live.reason ?? c.portable.reason;
  return typeof reason === 'string' && reason ? p(reason, { max: 160 }) : 'a signature does not verify';
}

/**
 * @param {string} file  A path (a leading `~/` is expanded).
 * @param {import('./session.js').Ctx} ctx
 * @param {{ account?: boolean }} [o]  `account`: an account exists, so the closing line says only that nothing was recorded; without one it points at setting an account up.
 * @returns {Promise<number>}  0 verified, 2 not.
 */
export async function checkFileCmd(file, ctx, o = {}) {
  const abs = expandHome(file.trim(), ctx.env);
  let st;
  try { st = await fs.stat(abs); } catch { throw new UsageError(`cannot read ${tilde(abs, ctx.env)}: no such file`); }
  if (!st.isFile()) throw new UsageError(`${tilde(abs, ctx.env)} is not a file`);
  if (st.size > MAX_TOTAL_BYTES * 2) throw new UsageError(`${tilde(abs, ctx.env)} is larger than mailproof reads (${MAX_TOTAL_BYTES * 2} bytes)`);
  const raw = await fs.readFile(abs);
  // nothing is written: the trail directory only names an instance, it is never created
  const mp = new Mailproof({ trailDir: path.join(os.tmpdir(), 'mailproof-check-only'), otsBin: null, worker: { size: 0 } });
  const c = await (ctx.deps.check ? ctx.deps.check(raw) : mp.check(raw));
  const s = styleOf(ctx);
  const ok = c.live.trust === 'verified' && c.portable.trust === 'verified';
  const part = !ok && (c.live.trust === 'verified' || c.portable.trust === 'verified');
  const { from, subject } = claimedHeaders(raw);
  // the result block: the verdict in plain words, then one fact per line
  print(ctx, ok ? s.green(`${s.sym.ok} verified: the signature checks out`) : part ? s.yellow(`${s.sym.warn} partly verified: live ${p(c.live.trust)}, portable ${p(c.portable.trust)}`) : s.yellow(`${s.sym.bad} not verified: ${whyNot(c)}`));
  /** @param {string} label @param {string} v */
  const row = (label, v) => print(ctx, `  ${s.dim(label.padEnd(11))} ${v}`);
  row('From', from === null ? s.dim('(none)') : p(from, { max: 120 }));
  row('Subject', subject === null ? s.dim('(none)') : p(subject, { max: 120 }));
  row('Signatures', `${c.signatures}${c.unsigned ? ' (unsigned)' : ''}`);
  row('Trust', `live ${p(c.live.trust)}, portable ${p(c.portable.trust)}`);
  row('Body', p(c.body_status));
  if (ok === false && c.key_errors.length > 1) for (const e of c.key_errors.slice(1)) row('', s.yellow(p(e, { max: 300 })));
  print(ctx, '');
  print(ctx, s.dim(o.account ? 'checked only, not recorded' : 'checked now, with DNS; nothing was recorded. To keep a proof, set up an account and sync.'));
  return ok ? EX_OK : EX_NO;
}
