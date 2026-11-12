// The MCP tool table (SPEC B12.3, B12.4): the only place MCP-specific text is written. Per tool: the library method it
// calls, its class, the four annotations, a title, and the parameters. `scripts/gen-mcp-tools.mjs` merges this table with
// primitives.json (the description) into `tools.generated.js`; a unit test checks the table against the library.
// The `account` property is not here: the server adds it when it builds `tools/list` (B12.2).

import { COMMANDS } from '../cli/commands.js';

/**
 * @typedef {Object} ParamSpec  A JSON Schema fragment for one property.
 * @property {string | string[]} type
 * @property {string} description
 * @property {string[]} [enum]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {{ type: string }} [items]
 */
/**
 * @typedef {Object} Annotations
 * @property {boolean} readOnlyHint
 * @property {boolean} destructiveHint
 * @property {boolean} idempotentHint
 * @property {boolean} openWorldHint
 */
/**
 * @typedef {Object} ToolSpec
 * @property {'read' | 'write' | 'destructive'} cls  Descriptive only: the server does not filter by it.
 * @property {string} title
 * @property {Annotations} annotations
 * @property {Record<string, ParamSpec>} params
 * @property {string[]} required
 * @property {boolean} [noAccount]  Takes no `account` (`accounts`, `verifyRecord`).
 * @property {string | null} [primitive]  Name in primitives.json; default `Mailproof#<name>`; null: the tool has its own `description`.
 * @property {string} [description]  Only for a tool with no primitive.
 */

/** @param {string} cmd @param {string} flag @returns {string} The CLI flag's help line: one definition of a flag's meaning. */
const flag = (cmd, flag) => {
  const f = COMMANDS[cmd]?.flags[flag];
  if (!f) throw new Error(`mcp tools: no CLI flag ${cmd} --${flag}`);
  return f.help.replace(/\s*\(default 50, 0 = no cap\)/, '');
};

/** @param {boolean} r @param {boolean} d @param {boolean} i @param {boolean} o @returns {Annotations} */
const hints = (r, d, i, o) => ({ readOnlyHint: r, destructiveHint: d, idempotentHint: i, openWorldHint: o });
const READ = hints(true, false, true, false);
const READ_DNS = hints(true, false, true, true);

/** @type {ParamSpec} */
const ID = { type: 'string', description: 'a record id: 32 hex characters, or a unique prefix of at least 8' };
/** @type {ParamSpec} */
const TARGET = { type: 'string', description: 'one exact email address (bob@example.com), a Message-ID in angle brackets (<abc@mail.example>), or a record id (8 to 32 hex characters)' };
/** @type {ParamSpec} */
const PATH = { type: 'string', description: 'absolute path of a file inside one of the server\'s input folders (mcp.inputDirs in the config); give this or base64' };
/** @type {ParamSpec} */
const B64 = { type: 'string', description: 'the exact bytes, base64-encoded; give this or path' };
/** @type {ParamSpec} */
const SAVE_TO = { type: 'string', description: 'a file name (not a path): write the bytes into the server\'s output folder (mcp.outputDir) instead of returning them' };
/** @type {ParamSpec} */
const CONFIRM = { type: 'boolean', description: 'true to do it; without it nothing changes and a preview is returned' };
/** @type {ParamSpec} */
const AT = { type: 'string', description: flag('verify', 'at') };
/** @param {number} max @param {string} what @returns {ParamSpec} */
const LIMIT = (max, what) => ({ type: 'integer', minimum: 1, maximum: max, description: `most ${what} to return (at most ${max})` });

/** @type {Record<string, ToolSpec>} */
export const TOOLS = {
  accounts: {
    cls: 'read', title: 'List the configured accounts', annotations: READ, params: {}, required: [], noAccount: true, primitive: null,
    description: 'List the mailproof accounts this server can use, as { name, user, host, trailDir, trail, records?, content: { store, attachments, days }, ots }. Names and local paths only: no secrets. Use a name as the `account` argument of the other tools. Opens no trail.',
  },
  list: {
    cls: 'read', title: 'List recorded emails', annotations: READ, required: [],
    params: {
      limit: LIMIT(500, 'rows'),
      direction: { type: 'string', enum: ['in', 'out'], description: flag('list', 'direction') },
      with: { type: 'string', description: flag('list', 'with') },
      role: { type: 'string', enum: ['from', 'to', 'cc', 'reply-to'], description: flag('list', 'role') },
      subject: { type: 'string', description: flag('list', 'subject') },
      before: { type: 'string', description: flag('list', 'before') },
      after: { type: 'string', description: flag('list', 'after') },
    },
  },
  describe: {
    cls: 'read', title: 'See one email, or everything with an address', annotations: READ, required: ['target'],
    params: {
      target: TARGET,
      full: { type: 'boolean', description: 'true: the whole body text of each email (else its first 10 lines and the count of the rest)' },
      after: { type: 'string', description: flag('show', 'after') },
      before: { type: 'string', description: flag('show', 'before') },
      limit: LIMIT(500, 'emails'),
    },
  },
  get: { cls: 'read', title: 'Read one record', annotations: READ, params: { id: ID }, required: ['id'] },
  copies: {
    cls: 'read', title: 'Copies of one message', annotations: READ, required: ['id'],
    params: { id: { type: 'string', description: 'the id of any copy (32 hex, or a unique prefix of at least 8), or the shared message_key' } },
  },
  counterparties: { cls: 'read', title: 'List counterparties', annotations: READ, params: { limit: LIMIT(500, 'addresses') }, required: [] },
  linked: { cls: 'read', title: 'Thread links of one record', annotations: READ, params: { id: ID, limit: { type: 'integer', minimum: 1, description: 'most children to return (default 1000)' } }, required: ['id'] },
  verify: { cls: 'read', title: 'Re-check one record offline', annotations: READ, params: { id: ID, at: AT }, required: ['id'] },
  verifyWith: {
    cls: 'read', title: 'Re-check every email with an address', annotations: READ, required: ['target'],
    params: {
      target: TARGET,
      all: { type: 'boolean', description: 'true: count your sent copies too (by default only received emails decide ok)' },
      after: { type: 'string', description: flag('verify', 'after') },
      before: { type: 'string', description: flag('verify', 'before') },
      limit: LIMIT(500, 'records'),
      at: AT,
    },
  },
  verifyRecord: {
    cls: 'read', title: 'Re-check an exported record', annotations: READ, noAccount: true, required: [],
    params: { record: { type: ['object', 'string'], description: 'an exported record (the JSON object, or its JSON text); give this or path' }, path: { ...PATH, description: 'absolute path of a record JSON file inside one of the server\'s input folders; give this or record' }, at: AT },
  },
  proofParts: { cls: 'read', title: 'Re-check the stored parts of a record', annotations: READ, params: { id: ID }, required: ['id'] },
  checkProfile: {
    cls: 'read', title: 'Check a record against a trust profile', annotations: READ, required: ['id', 'profile'],
    params: {
      id: ID,
      profile: { type: 'object', description: 'a trust profile written inline (senders, checks, body, link; SPEC B8)' },
      at: AT,
      parent: { type: 'string', description: flag('check', 'parent') },
    },
  },
  replyFacts: {
    cls: 'read', title: 'Facts about the replies to an email', annotations: READ, required: [],
    params: {
      messageId: { type: 'string', description: 'the Message-ID of the email you sent, like <id@host> (give this or address)' },
      address: { type: 'string', description: 'one exact email address: the replies that person sent (give this or messageId)' },
    },
  },
  matchBody: { cls: 'read', title: 'Does a body match the signed hash', annotations: READ, params: { id: ID, path: PATH, base64: B64 }, required: ['id'] },
  matchFile: { cls: 'read', title: 'Is this file the recorded attachment', annotations: READ, params: { id: ID, path: PATH, base64: B64 }, required: ['id'] },
  rawEmail: { cls: 'read', title: 'Get the stored raw email', annotations: READ, params: { id: ID, saveTo: SAVE_TO }, required: ['id'] },
  attachment: {
    cls: 'read', title: 'Get a stored attachment', annotations: READ, required: ['sha256'],
    params: { sha256: { type: 'string', description: 'the attachment\'s sha256, 64 hex characters (optionally with a sha256: prefix)' }, saveTo: SAVE_TO },
  },
  check: { cls: 'read', title: 'Check an email without recording it', annotations: READ_DNS, params: { path: PATH, base64: B64 }, required: [] },
  record: {
    cls: 'write', title: 'Record an email', annotations: hints(false, false, true, true), required: ['direction'],
    params: {
      path: PATH, base64: B64,
      direction: { type: 'string', enum: ['in', 'out'], description: 'in: received by the account owner; out: sent by them' },
      source: { type: 'string', description: 'where the email came from, kept in the record (default "mcp")' },
    },
  },
  replyText: { cls: 'write', title: 'Read and fingerprint a reply\'s new text', annotations: hints(false, false, true, false), params: { id: ID }, required: ['id'] },
  sync: {
    cls: 'write', title: 'Fetch new mail from the mailbox', annotations: hints(false, false, false, true), required: [],
    params: {
      folders: { type: 'array', items: { type: 'string' }, minItems: 1, description: flag('sync', 'folders') },
      sent: { type: ['boolean', 'string'], description: flag('sync', 'sent') },
      maxMessages: { type: 'integer', minimum: 1, description: 'most messages to read per folder in this call (default set by the server); call again while complete is false' },
    },
  },
  status: { cls: 'read', title: 'Status of the account and its trail', annotations: READ, params: {}, required: [] },
  stamp: { cls: 'write', title: 'Seal new mail (OpenTimestamps)', annotations: hints(false, false, true, true), params: {}, required: [] },
  upgradeStamps: { cls: 'write', title: 'Upgrade OpenTimestamps stamps', annotations: hints(false, false, false, true), params: {}, required: [] },
  export: {
    cls: 'write', title: 'Export a proof bundle for a counterparty', annotations: hints(false, false, false, false), required: ['with'],
    params: {
      with: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'the exact email addresses to export the exchange with (a union: any email naming one of them on From, To, Cc or Reply-To)' },
      after: { type: 'string', description: flag('export', 'after') },
      before: { type: 'string', description: flag('export', 'before') },
      out: { type: 'string', description: 'a folder name (not a path) to create inside the server\'s output folder (mcp.outputDir); default mailproof-bundle-<account>-<time>' },
      tar: { type: 'boolean', description: 'true: one .tar file instead of a folder' },
      confirm: CONFIRM,
    },
  },
  backup: {
    cls: 'write', title: 'Back up the trail', annotations: hints(false, false, false, true), required: [],
    params: {
      out: { type: 'string', description: 'a file name (not a path) for the bundle inside the server\'s output folder (mcp.outputDir); default <account>-<time>.bundle' },
      withContent: { type: 'boolean', description: 'true: also write the stored raw emails as an unencrypted .content.tar beside it' },
      push: { type: 'boolean', description: 'true: also push the trail to the account\'s backup remote (never forced; contacts that host)' },
      confirm: CONFIRM,
    },
  },
  verifyBundle: {
    cls: 'read', title: 'Check a proof bundle', annotations: READ, noAccount: true, primitive: 'verifyBundle', required: ['dir'],
    params: {
      dir: { type: 'string', description: 'absolute path of the bundle folder, inside one of the server\'s input folders (mcp.inputDirs)' },
      expect: { type: 'string', description: flag('verify-bundle', 'expect') },
      strict: { type: 'boolean', description: flag('verify-bundle', 'strict') },
    },
  },
  forget: {
    cls: 'destructive', title: 'Forget stored mail content', annotations: hints(false, true, true, false), required: [],
    params: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1000, description: 'record ids (32 hex, or unique prefixes of at least 8); instead of with' },
      with: { type: 'string', description: flag('forget', 'with') },
      before: { type: 'string', description: flag('forget', 'before') },
      after: { type: 'string', description: flag('forget', 'after') },
      confirm: CONFIRM,
    },
  },
  prune: {
    cls: 'destructive', title: 'Prune old history', annotations: hints(false, true, true, false), required: ['before'],
    params: { before: { type: 'string', description: flag('prune', 'before') }, confirm: CONFIRM },
  },
};

/**
 * Library surface that is deliberately not a tool, one reason each (SPEC B12.3). Keys are primitives.json names, or the
 * name of an exported constant.
 * @type {Record<string, string>}
 */
export const EXCLUDED = {
  'Mailproof': 'construction: the server builds one instance per account from the config.',
  'Mailproof#close': 'lifecycle: the server owns it; an agent calling it would end its own worker.',
  'watch': 'the CLI command mailproof watch is a long-running loop that never returns; over MCP call sync again (it also runs the seal when due).',
  'config add-account': 'the CLI wizard is interactive and handles the account secret; an agent must never be given one. status reports whether the config validates.',
  'help': 'the tool list and every description already are the help.',
  'mcp': 'the server itself.',
  'Mailproof#expireContent': 'policy, not an agent need: sync enforces retention every sweepDays and forget is the on-demand tool.',
  'hashDocument': 'a pure helper; matchFile answers the real question and a model cannot usefully hand it bytes.',
  'checkProfile': 'the method of the same name covers it by id: one tool per name.',
  'TRUST_LEVELS': 'a constant: the server and initialize.serverInfo own constants.',
  'RULES_VERSION': 'a constant: every verdict already carries it.',
};

/** Argument names that are not parameters of the library method (the server flattens, resolves or adds them); exempt from the signature check. */
export const SERVER_ARGS = new Set(['account', 'path', 'base64', 'saveTo', 'confirm', 'ids', 'id']);
