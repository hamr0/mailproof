// The installed version and the upgrade command: one definition for `update`, `status` and the MCP server.

import fs from 'node:fs';

/** @returns {string} The installed version. */
export const version = () => JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export const NPM_ARGS = ['install', '-g', 'mailproof@latest'];

/** The command that upgrades mailproof (`update` runs it with --run; the MCP server never does). */
export const UPDATE_COMMAND = `npm ${NPM_ARGS.join(' ')}`;
