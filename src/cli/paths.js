// The paths a person sees and the folders mailproof writes FOR them (SPEC B11.2a). Everything it makes for the owner (an export, a backup, a
// saved attachment) goes under `~/mailproof/<kind>/`: absolute under $HOME (never relative to the current directory), created with mode 0700 on
// first use, shown with `~/`. One home lookup and one `~` expansion for the whole CLI (config.js owns both; passFile uses the same).

import fs from 'node:fs/promises';
import path from 'node:path';
import { expandHome, homeOf } from './config.js';

export { expandHome };

/** The kinds of folder under `~/mailproof/`. @typedef {'exports' | 'backups' | 'saved'} UserKind */

/**
 * A path with the home directory shown as `~`; anything else as it is. Display only: the text is not a path to open.
 * @param {string} f
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function tilde(f, env) {
  const h = homeOf(env);
  if (!h || !path.isAbsolute(f)) return f;
  if (f === h) return '~';
  const base = h.endsWith('/') ? h : `${h}/`;
  return f.startsWith(base) ? `~/${f.slice(base.length)}` : f;
}

/**
 * Free text with every `<home>/` shown as `~/` (an error message that names a path). Display only.
 * @param {string} text
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function tildeText(text, env) {
  const h = homeOf(env);
  if (!h || h === '/') return text;
  const base = h.endsWith('/') ? h : `${h}/`;
  return text.split(base).join('~/');
}

/**
 * `<home>/mailproof/<kind>`: where mailproof writes this kind of file for the person.
 * @param {Record<string, string | undefined>} env
 * @param {UserKind} kind
 * @returns {string}
 */
export const userDir = (env, kind) => path.join(homeOf(env), 'mailproof', kind);

/**
 * Create `<home>/mailproof/<kind>` (mode 0700; an existing `~/mailproof` keeps its mode) and return it.
 * @param {Record<string, string | undefined>} env
 * @param {UserKind} kind
 * @returns {Promise<string>}
 */
export async function ensureUserDir(env, kind) {
  const d = userDir(env, kind);
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  return d;
}

/**
 * Make sure the folder of a DEFAULT path exists: when `file` sits directly in `<home>/mailproof/<kind>` that folder is created (0700). A path the
 * person chose is left to the command, which says what is missing.
 * @param {string} file
 * @param {Record<string, string | undefined>} env
 * @param {UserKind} kind
 * @returns {Promise<void>}
 */
export async function ensureDefaultDir(file, env, kind) {
  if (path.dirname(path.resolve(file)) === userDir(env, kind)) await ensureUserDir(env, kind);
}
