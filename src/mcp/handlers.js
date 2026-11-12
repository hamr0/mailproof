// What each tool does (SPEC B12.3): validate and convert the arguments, call the library, return JSON. No proof logic of
// its own. Dates are ISO strings, ids may be unique prefixes, bytes come in as base64 or an allowed path and go out as a
// blob or a saved file. `forget` and `prune` preview unless `confirm: true` (B12.5).

import crypto from 'node:crypto';
import { verifyRecord } from '../index.js';
import { parseDate, parseAddress, resolveId, messageIdOf } from '../cli/parse.js';
import { syncOnce } from '../cli/sync-op.js';
import { readBytes, readAllowedFile, saveBytes } from './input.js';
import { ToolError, badArgument } from './errors.js';

/** Messages read per folder in one `sync` call unless the caller lowers it (SPEC B12.12: about 8 s for 100 signed 40 KB messages, F30). */
export const SYNC_MAX_MESSAGES_DEFAULT = 100;
/** Message count the `maxMessages` argument may not exceed (the library caps a folder at 1,000 anyway). */
export const SYNC_MAX_MESSAGES_CEILING = 1000;

/** @typedef {import('../index.js').Mailproof} Mailproof */
/** @typedef {{ type: 'text', text: string } | { type: 'resource', resource: { uri: string, mimeType: string, blob: string } }} Content */
/** @typedef {{ content: Content[], outcome?: string }} Output */

/**
 * What a handler may use.
 * @typedef {Object} HandlerCtx
 * @property {import('../cli/config.js').Account | null} account  Null for a tool with no account.
 * @property {() => Mailproof} mp  The account's instance, opened on first use.
 * @property {import('../cli/config.js').McpConfig} settings
 * @property {import('./input.js').InputOptions} input
 * @property {() => Promise<Output>} accounts  The `accounts` tool.
 * @property {string} state  The state directory (sync updates the account's state.json there).
 * @property {import('../cli/session.js').Deps} deps
 * @property {Record<string, string | undefined>} env
 * @property {string} configFile
 */

/** @param {unknown} v @param {string} [outcome] @returns {Output} */
export const json = (v, outcome = 'ok') => ({ content: [{ type: 'text', text: JSON.stringify(v) }], outcome });

/** @param {Record<string, any>} a @param {string} k @param {Mailproof} mp @returns {Promise<string>} The full id of an `id` argument. */
const idArg = (a, k, mp) => resolveId(a[k], mp.root);

/** @param {unknown} v @param {string} name @returns {Date} */
const dateArg = (v, name) => parseDate(/** @type {string} */ (v), name);

/**
 * @param {Record<string, any>} a
 * @returns {{ limit?: number, direction?: 'in' | 'out', with?: string, role?: 'from' | 'to' | 'cc' | 'reply-to', before?: Date, after?: Date }}
 */
function listFilters(a) {
  /** @type {ReturnType<typeof listFilters>} */
  const f = {};
  if (a.with !== undefined) f.with = parseAddress(a.with, 'with');
  if (a.role !== undefined) { if (f.with === undefined) throw badArgument('role needs with'); f.role = a.role; }
  if (a.direction !== undefined) f.direction = a.direction;
  if (a.before !== undefined) f.before = dateArg(a.before, 'before');
  if (a.after !== undefined) f.after = dateArg(a.after, 'after');
  return f;
}

/**
 * `{ found: false }` for a library null, the value otherwise.
 * @param {unknown} v
 * @returns {Output}
 */
const orNotFound = (v) => json(v ?? { found: false });

/**
 * The bytes of a stored email or attachment, as a resource blob or a saved file.
 * @param {HandlerCtx} c
 * @param {Buffer | null} bytes
 * @param {{ kind: 'raw' | 'attachment', key: string, mime: string }} what
 * @param {string | undefined} saveTo
 * @returns {Promise<Output>}
 */
async function bytesOut(c, bytes, what, saveTo) {
  if (!bytes) return json({ found: false });
  const meta = { id: what.key, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  if (saveTo !== undefined) return json({ ...meta, saved: await saveBytes(saveTo, bytes, c.settings.outputDir) });
  if (bytes.length > c.settings.maxBinaryBytes) throw new ToolError('ERR_TOO_LARGE', `the content is ${bytes.length} bytes, over the ${c.settings.maxBinaryBytes} byte limit for a returned blob; call again with saveTo (needs mcp.outputDir)`);
  const uri = `mailproof://${c.account?.name}/${what.kind === 'raw' ? 'raw' : 'attachment'}/${what.key}`;
  return {
    content: [
      { type: 'resource', resource: { uri, mimeType: what.mime, blob: bytes.toString('base64') } },
      { type: 'text', text: JSON.stringify(meta) },
    ],
    outcome: 'ok',
  };
}

/** @typedef {(c: HandlerCtx, a: Record<string, any>) => Promise<Output>} Handler */

/** @type {Record<string, Handler>} */
export const HANDLERS = {
  accounts: (c) => c.accounts(),
  list: async (c, a) => json(await c.mp().list({ ...listFilters(a), limit: a.limit ?? 50 })),
  get: async (c, a) => { const mp = c.mp(); return orNotFound(await mp.get(await idArg(a, 'id', mp))); },
  copies: async (c, a) => {
    const mp = c.mp();
    const key = /^[0-9a-fA-F]{8,31}$/.test(a.id) ? await resolveId(a.id, mp.root) : a.id;   // a prefix names a record; anything else is passed through (a message_key)
    return json(await mp.copies(key));
  },
  counterparties: async (c, a) => json(await c.mp().counterparties({ limit: a.limit ?? 100 })),
  linked: async (c, a) => { const mp = c.mp(); return orNotFound(await mp.linked(await idArg(a, 'id', mp), a.limit === undefined ? undefined : { limit: a.limit })); },
  verify: async (c, a) => {
    const mp = c.mp();
    const id = await idArg(a, 'id', mp);
    const rec = await mp.get(id);
    if (!rec) return json({ found: false });
    return json(await mp.verify(rec, a.at === undefined ? undefined : { at: dateArg(a.at, 'at') }));
  },
  describe: async (c, a) => json(await c.mp().describe(a.target, { ...(a.full !== undefined ? { full: a.full } : {}), ...(a.after !== undefined ? { after: dateArg(a.after, 'after') } : {}), ...(a.before !== undefined ? { before: dateArg(a.before, 'before') } : {}), limit: a.limit ?? 50 })),
  verifyWith: async (c, a) => json(await c.mp().verifyWith(a.target, {
    ...(a.all !== undefined ? { all: a.all } : {}), ...(a.at !== undefined ? { at: dateArg(a.at, 'at') } : {}),
    ...(a.after !== undefined ? { after: dateArg(a.after, 'after') } : {}), ...(a.before !== undefined ? { before: dateArg(a.before, 'before') } : {}),
    ...(a.limit !== undefined ? { limit: a.limit } : {}),
  })),
  verifyRecord: async (c, a) => {
    const hasPath = a.path !== undefined;
    if (hasPath === (a.record !== undefined)) throw badArgument('give record or path, not both and not neither');
    /** @type {unknown} */
    let record = a.record;
    if (hasPath) {
      try { record = JSON.parse((await readAllowedFile(a.path, c.input)).toString('utf8')); } catch (e) { if (e instanceof ToolError) throw e; throw badArgument('path is not a JSON file'); }
    }
    return json(await verifyRecord(/** @type {any} */ (record), a.at === undefined ? undefined : { at: dateArg(a.at, 'at') }));
  },
  proofParts: async (c, a) => { const mp = c.mp(); return orNotFound(await mp.proofParts(await idArg(a, 'id', mp))); },
  checkProfile: async (c, a) => {
    const mp = c.mp();
    const opts = { ...(a.at !== undefined ? { at: dateArg(a.at, 'at') } : {}), ...(a.parent !== undefined ? { parent: messageIdOf(a.parent) } : {}) };
    return json(await mp.checkProfile(await idArg(a, 'id', mp), a.profile, Object.keys(opts).length ? opts : undefined));
  },
  replyFacts: async (c, a) => json(await c.mp().replyFacts({ messageId: messageIdOf(a.messageId) })),
  matchBody: async (c, a) => {
    const mp = c.mp();
    const raw = await readBytes(a, c.input, true);
    return json(await mp.matchBody(await idArg(a, 'id', mp), raw ?? undefined));
  },
  matchFile: async (c, a) => {
    const mp = c.mp();
    const bytes = /** @type {Buffer} */ (await readBytes(a, c.input));
    return json(await mp.matchFile(await idArg(a, 'id', mp), bytes));
  },
  rawEmail: async (c, a) => {
    const mp = c.mp();
    const id = await idArg(a, 'id', mp);
    return bytesOut(c, await mp.rawEmail(id), { kind: 'raw', key: id, mime: 'message/rfc822' }, a.saveTo);
  },
  attachment: async (c, a) => {
    if (!/^(sha256:)?[0-9a-f]{64}$/i.test(a.sha256)) throw badArgument('sha256 must be 64 hex characters');
    const hex = a.sha256.toLowerCase().replace(/^sha256:/, '');
    return bytesOut(c, await c.mp().attachment(hex), { kind: 'attachment', key: hex, mime: 'application/octet-stream' }, a.saveTo);
  },
  check: async (c, a) => json(await c.mp().check(/** @type {Buffer} */ (await readBytes(a, c.input)))),
  record: async (c, a) => json(await c.mp().record(/** @type {Buffer} */ (await readBytes(a, c.input)), { direction: a.direction, source: a.source ?? 'mcp' })),
  replyText: async (c, a) => { const mp = c.mp(); return json(await mp.replyText({ id: await idArg(a, 'id', mp) })); },
  sync: async (c, a) => {
    const account = /** @type {import('../cli/config.js').Account} */ (c.account);
    const over = {
      ...(a.folders !== undefined ? { folders: a.folders } : {}),
      ...(a.sent !== undefined ? { sent: a.sent } : {}),
      maxMessages: Math.min(a.maxMessages ?? SYNC_MAX_MESSAGES_DEFAULT, SYNC_MAX_MESSAGES_CEILING),
    };
    /** @type {import('../cli/session.js').Ctx} */
    const cliCtx = { stdout: { write: () => true }, stderr: { write: () => true }, stdin: null, interactive: false, env: c.env, signal: new AbortController().signal, deps: c.deps };
    const r = await syncOnce({ account, mp: c.mp(), state: c.state, configFile: c.configFile, close: async () => {} }, cliCtx, over);
    const recorded = r.result.folders.reduce((n, f) => n + f.recorded, 0);
    return json({ ...r.result, ots: r.ots }, `ok recorded ${recorded}${r.result.complete ? '' : ' (not complete)'}`);
  },
  upgradeStamps: async (c) => json(await c.mp().upgradeStamps()),
  forget: async (c, a) => {
    const mp = c.mp();
    const hasIds = a.ids !== undefined;
    const hasWith = a.with !== undefined;
    if (hasIds === hasWith) throw badArgument('give ids or with, not both and not neither (there is no "forget everything")');
    if (!hasWith && (a.before !== undefined || a.after !== undefined)) throw badArgument('before and after go with with');
    const target = hasIds
      ? await Promise.all(/** @type {string[]} */ (a.ids).map((i) => resolveId(i, mp.root)))
      : { with: parseAddress(a.with, 'with'), ...(a.before !== undefined ? { before: dateArg(a.before, 'before') } : {}), ...(a.after !== undefined ? { after: dateArg(a.after, 'after') } : {}) };
    if (a.confirm !== true) {
      const plan = await mp.forget(target, { dryRun: true });
      return json({ executed: false, preview: plan, next: 'call again with confirm: true to do this' }, `preview ${plan.ids?.length ?? 0} record(s), ${plan.removed} stored`);
    }
    const res = await mp.forget(target);
    return json({ executed: true, result: res }, `executed removed ${res.removed}, attachments ${res.attachments}`);
  },
  prune: async (c, a) => {
    const mp = c.mp();
    const before = dateArg(a.before, 'before');
    if (a.confirm !== true) {
      const plan = await mp.prune({ before, dryRun: true });
      return json({ executed: false, preview: plan, next: 'call again with confirm: true to do this' }, `preview removed ${plan.removed}, kept ${plan.kept}`);
    }
    const res = await mp.prune({ before });
    return json({ executed: true, result: res }, `executed removed ${res.removed}, kept ${res.kept}`);
  },
};

