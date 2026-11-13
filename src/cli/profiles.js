// Trust profiles by name (SPEC B8, B11.5): the one place that knows where profiles live and what `default` means. The CLI (`check --profile`,
// the menu) and the MCP server (`checkProfile`, `profiles`) both resolve through here. A profile is a JSON file `<configDir>/profiles/<name>.json`;
// the built-in `default` (the DKIM baseline) stands in unless the person made their own `default.json`. Profiles hold no secrets, so no mode check.

import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './config.js';
import { UsageError } from './errors.js';
import { DEFAULT_PROFILE, profileSummary } from './profile-text.js';

/** A bare profile name: no path separators, no dots at the start. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Where the named profiles live.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export const profilesDir = (env) => path.join(configDir(env), 'profiles');

/**
 * Read and parse one profile file. A missing `default` is the built-in baseline.
 * @param {string} file
 * @param {string} spec  What the person typed (for the refusal).
 * @param {boolean} isName
 * @param {string} who  The argument's name in a refusal (`--profile`, `profile`).
 * @returns {Promise<unknown>}
 */
async function readProfile(file, spec, isName, who) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) {
    if (spec === 'default' && /** @type {any} */ (e).code === 'ENOENT') return DEFAULT_PROFILE;   // the built-in baseline, unless the person made their own `default.json`
    throw new UsageError(`${who}: cannot read ${file} (${/** @type {any} */ (e).code ?? 'error'})${isName ? '; a bare name is looked up in the profiles directory, use a path for another place' : ''}`);
  }
  try { return JSON.parse(text); } catch (e) { throw new UsageError(`${who}: ${file} is not valid JSON: ${/** @type {Error} */ (e).message}`); }
}

/**
 * A profile for the CLI: a path as given, else `<configDir>/profiles/<name>.json`.
 * @param {string} spec
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<unknown>}  The parsed JSON.
 */
export function loadProfile(spec, env) {
  const isName = PROFILE_NAME_RE.test(spec);
  return readProfile(isName ? path.join(profilesDir(env), `${spec}.json`) : path.resolve(spec), spec, isName, '--profile');
}

/**
 * A profile for the MCP server: nothing (the built-in `default`), a bare name in the profiles directory, or the profile itself as an object.
 * Never a path: the server reads no file the person did not put in the profiles directory.
 * @param {unknown} v
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<unknown>}
 */
export async function resolveProfile(v, env) {
  if (v === undefined) return resolveProfile('default', env);
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v;
  if (typeof v !== 'string') throw new UsageError('profile: give a profile name or an object');
  if (!PROFILE_NAME_RE.test(v)) throw new UsageError('profile: a profile name is letters, digits, - and _ (a path is not accepted); list them with the profiles tool');
  return readProfile(path.join(profilesDir(env), `${v}.json`), v, true, 'profile');
}

/**
 * The profiles a person can name: the built-in `default` (unless their own `default.json` replaces it) and every `<configDir>/profiles/<name>.json`,
 * each with its one-line meaning. A file that cannot be read or parsed is listed with that said, never thrown.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<Array<{ name: string, summary: string, builtin: boolean }>>}
 */
export async function listProfiles(env) {
  const dir = profilesDir(env);
  /** @type {string[]} */
  let files = [];
  try { files = (await fs.readdir(dir)).filter((f) => /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(f)).sort(); } catch { /* no profiles directory */ }
  /** @type {Array<{ name: string, summary: string, builtin: boolean }>} */
  const out = [];
  if (!files.includes('default.json')) out.push({ name: 'default', summary: profileSummary(DEFAULT_PROFILE), builtin: true });
  for (const f of files) {
    const name = f.slice(0, -5);
    try { out.push({ name, summary: profileSummary(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'))), builtin: false }); }
    catch { out.push({ name, summary: 'cannot be read or is not JSON', builtin: false }); }
  }
  return out;
}
