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
import { MAX_TOTAL_BYTES } from '../proof/limits.js';

/**
 * @param {string} file  A path (a leading `~/` is expanded).
 * @param {import('./session.js').Ctx} ctx
 * @returns {Promise<number>}  0 verified, 2 not.
 */
export async function checkFileCmd(file, ctx) {
  const abs = expandHome(file.trim(), ctx.env);
  let st;
  try { st = await fs.stat(abs); } catch { throw new UsageError(`cannot read ${tilde(abs, ctx.env)}: no such file`); }
  if (!st.isFile()) throw new UsageError(`${tilde(abs, ctx.env)} is not a file`);
  if (st.size > MAX_TOTAL_BYTES * 2) throw new UsageError(`${abs} is larger than mailproof reads (${MAX_TOTAL_BYTES * 2} bytes)`);
  const raw = await fs.readFile(abs);
  // nothing is written: the trail directory only names an instance, it is never created
  const mp = new Mailproof({ trailDir: path.join(os.tmpdir(), 'mailproof-check-only'), otsBin: null, worker: { size: 0 } });
  const c = await (ctx.deps.check ? ctx.deps.check(raw) : mp.check(raw));
  const s = styleOf(ctx);
  const ok = c.live.trust === 'verified' && c.portable.trust === 'verified';
  print(ctx, `${ok ? s.green(`${s.sym.ok} verified`) : s.yellow(`${s.sym.warn} ${p(c.live.trust)}`)}  live ${p(c.live.trust)}, portable ${p(c.portable.trust)}, ${c.signatures} signature${c.signatures === 1 ? '' : 's'}${c.unsigned ? ' (unsigned)' : ''}, body ${p(c.body_status)}`);
  for (const e of c.key_errors) print(ctx, `   ${s.dim('why:')} ${s.yellow(p(e, { max: 300 }))}`);
  print(ctx, s.dim('checked now, with DNS; nothing was recorded. To keep a proof, set up an account and sync.'));
  return ok ? EX_OK : EX_NO;
}
