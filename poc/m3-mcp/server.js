#!/usr/bin/env node
// POC (never shipped): a dependency-free MCP server over stdio. Newline-delimited JSON-RPC 2.0, stdlib only.
// Read-only tools on one trail. Env: MAILPROOF_POC_TRAIL_DIR (required), MAILPROOF_POC_TRAIL (default "default"),
// MAILPROOF_POC_LOG=1 logs to stderr (stdout carries protocol only).
import readline from 'node:readline';
import { Mailproof } from '../../src/index.js';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const log = (...a) => { if (process.env.MAILPROOF_POC_LOG) process.stderr.write(`[mailproof-mcp] ${a.join(' ')}\n`); };

const trailDir = process.env.MAILPROOF_POC_TRAIL_DIR;
if (!trailDir) { process.stderr.write('MAILPROOF_POC_TRAIL_DIR is required\n'); process.exit(64); }
const mp = new Mailproof({ trailDir, trail: process.env.MAILPROOF_POC_TRAIL || 'default' });

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', minimum: 1, description });
const TOOLS = [
  { name: 'list', description: 'List recorded emails, newest capture first, optionally by counterparty address, direction or date.',
    inputSchema: { type: 'object', properties: { limit: int('most entries'), direction: { type: 'string', enum: ['in', 'out'] }, with: str('one exact email address'), role: { type: 'string', enum: ['from', 'to', 'cc', 'reply-to'] }, before: str('captured before this date (ISO)'), after: str('captured after this date (ISO)') }, additionalProperties: false },
    run: (a) => mp.list(a) },
  { name: 'show', description: 'Read one stored record (its signed headers, verdicts, attachments hashes; never the body) by id.',
    inputSchema: { type: 'object', properties: { id: str('record id (32 hex)') }, required: ['id'], additionalProperties: false },
    run: async (a) => (await mp.get(a.id)) ?? Promise.reject(new Error(`no record ${a.id}`)) },
  { name: 'verify', description: 'Re-check a record offline from the record alone (portable verdict).',
    inputSchema: { type: 'object', properties: { id: str('record id (32 hex)') }, required: ['id'], additionalProperties: false },
    run: (a) => mp.verify(a.id) },
  { name: 'replyFacts', description: 'The facts about every direct reply to one email you sent: sender, DKIM proof, link strength, new text.',
    inputSchema: { type: 'object', properties: { messageId: str('Message-ID of the request, e.g. <id@host>') }, required: ['messageId'], additionalProperties: false },
    run: (a) => mp.replyFacts(a) },
  { name: 'counterparties', description: 'Every exact address seen in the trail with record counts and first/last capture.',
    inputSchema: { type: 'object', properties: { limit: int('most entries') }, additionalProperties: false },
    run: (a) => mp.counterparties(a) },
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Minimal JSON Schema check for the flat schemas above (type, enum, minimum, required, additionalProperties).
function checkArgs(schema, a) {
  for (const k of schema.required ?? []) if (!(k in a)) return `missing "${k}"`;
  for (const [k, v] of Object.entries(a)) {
    const p = schema.properties[k];
    if (!p) return `unknown argument "${k}"`;
    if (p.type === 'integer' ? !Number.isInteger(v) || v < (p.minimum ?? -Infinity) : typeof v !== 'string') return `"${k}" must be ${p.type === 'integer' ? 'a positive integer' : 'a string'}`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}`;
  }
  return null;
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      if (!isObj(params) || typeof params.protocolVersion !== 'string') throw new RpcError(-32602, 'initialize needs protocolVersion');
      const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      log('initialize client', params.clientInfo?.name, 'asked', params.protocolVersion, 'using', v);
      return { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mailproof-poc', version: '0.0.0' } };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      if (!isObj(params) || typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs a tool name');
      const tool = BY_NAME.get(params.name);
      if (!tool) throw new RpcError(-32602, `unknown tool: ${params.name}`);
      const args = params.arguments ?? {};
      if (!isObj(args)) throw new RpcError(-32602, 'arguments must be an object');
      const bad = checkArgs(tool.inputSchema, args);
      if (bad) return { isError: true, content: [{ type: 'text', text: `invalid arguments: ${bad}` }] };
      try {
        const out = await tool.run(args);
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: `${e.code ? `${e.code}: ` : ''}${e.message}` }] };
      }
    }
    default: throw new RpcError(-32601, `method not found: ${method}`);
  }
}

/** One message in, the response object (or null for a notification / nothing to answer). */
async function handle(msg) {
  if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || ('id' in msg && typeof msg.id !== 'string' && typeof msg.id !== 'number')) {
    return { jsonrpc: '2.0', id: isObj(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
  }
  const note = !('id' in msg);
  try {
    const result = await dispatch(msg.method, msg.params);
    return note ? null : { jsonrpc: '2.0', id: msg.id, result };
  } catch (e) {
    if (note) return null; // unknown or failing notifications are ignored
    const rpc = e instanceof RpcError;
    if (!rpc) log('internal', e.stack);
    return { jsonrpc: '2.0', id: msg.id, error: { code: rpc ? e.code : -32603, message: rpc ? e.message : 'internal error' } };
  }
}

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const pending = new Set();
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const p = (async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    if (Array.isArray(msg)) { // JSON-RPC batch (2025-03-26 allowed it)
      if (!msg.length) return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      if (out.length) send(out);
      return undefined;
    }
    const r = await handle(msg);
    if (r) send(r);
    return undefined;
  })().finally(() => pending.delete(p));
  pending.add(p);
});
async function shutdown() { await Promise.allSettled([...pending]); await mp.close(); process.exit(0); }
rl.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
