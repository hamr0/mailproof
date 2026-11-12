// Where this copy of mailproof is installed and whether it is a development link: ONE detection for `update`, the MCP `status` tool and anything
// else that asks (SPEC B11.10, B12.3). No network: the registry lookup stays in `update --check`.

import fs from 'node:fs';
import path from 'node:path';
import { tilde } from './paths.js';
import { UPDATE_COMMAND } from './version.js';

/**
 * Where this copy of mailproof lives, and whether it is a development link: its real folder is outside any `node_modules` or has a `.git`
 * (an `npm link` or a checkout), so npm must not replace it.
 * @returns {{ dev: boolean, dir: string }}
 */
export function installInfo() {
  const dir = fs.realpathSync(path.resolve(import.meta.dirname, '..', '..'));
  const dev = !dir.split(path.sep).includes('node_modules') || fs.existsSync(path.join(dir, '.git'));
  return { dev, dir };
}

/**
 * The install facts as data: `kind` is `dev-link` (update with git) or `npm` (update with the npm command), `path` the package folder, absolute (data; only prose shows `~/`).
 * `deps.installInfo` replaces the detection (tests).
 * @param {{ installInfo?: () => { dev: boolean, dir: string } }} deps
 * @param {Record<string, string | undefined>} env
 * @returns {{ kind: 'dev-link' | 'npm', path: string }}
 */
export function installFacts(deps, env) {
  const info = deps.installInfo ? deps.installInfo() : installInfo();
  return { kind: info.dev ? 'dev-link' : 'npm', path: info.dir };
}

/**
 * The one sentence for a development link, shown by `update` and carried by `status` (CLI and MCP): git, never npm.
 * @param {string} shownDir  The package folder, already shown as `~/`.
 * @returns {string}
 */
export const devLinkText = (shownDir) => `development link to ${shownDir}; update with git (git pull in that folder)`;

/**
 * The install facts plus how to update, for `status --json` and the MCP `status`: `updateCommand` (the npm command) only for a real
 * install; a development link gets `update` (the git hint) instead, never the npm command that would replace the link.
 * @param {{ installInfo?: () => { dev: boolean, dir: string } }} deps
 * @param {Record<string, string | undefined>} env
 * @returns {{ install: { kind: 'dev-link' | 'npm', path: string }, update: string } | { install: { kind: 'dev-link' | 'npm', path: string }, updateCommand: string }}
 */
export function updateFacts(deps, env) {
  const install = installFacts(deps, env);
  return install.kind === 'dev-link' ? { install, update: devLinkText(tilde(install.path, env)) } : { install, updateCommand: UPDATE_COMMAND };
}
