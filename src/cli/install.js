// Where this copy of mailproof is installed and whether it is a development link: ONE detection for `update`, the MCP `status` tool and anything
// else that asks (SPEC B11.10, B12.3). No network: the registry lookup stays in `update --check`.

import fs from 'node:fs';
import path from 'node:path';
import { tilde } from './paths.js';

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
 * The install facts as data: `kind` is `dev-link` (update with git) or `npm` (update with the npm command), `path` the package folder with the home shown as `~/`.
 * `deps.installInfo` replaces the detection (tests).
 * @param {{ installInfo?: () => { dev: boolean, dir: string } }} deps
 * @param {Record<string, string | undefined>} env
 * @returns {{ kind: 'dev-link' | 'npm', path: string }}
 */
export function installFacts(deps, env) {
  const info = deps.installInfo ? deps.installInfo() : installInfo();
  return { kind: info.dev ? 'dev-link' : 'npm', path: tilde(info.dir, env) };
}
