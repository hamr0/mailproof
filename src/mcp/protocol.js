// The MCP protocol core (SPEC B12.1, B12.8), lifted from the proven POC (poc/m3-mcp, F29): newline-delimited JSON-RPC 2.0,
// stdlib only. `initialize`, `ping`, `tools/list`, `tools/call`; notifications get no reply; batches are answered as a batch;
// requests run concurrently; a cancelled request's result is dropped. It knows nothing about mailproof: a server plugs in
// `listTools` and `callTool`.

export const SUPPORTED_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
/** A request line over this closes the message with -32600 and is dropped, never buffered without bound (B12.8). */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** A JSON-RPC protocol error. */
export class RpcError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} id @returns {id is string | number} */
const isId = (id) => typeof id === 'string' || typeof id === 'number';

/**
 * @typedef {Object} ProtocolOptions
 * @property {{ name: string, title: string, version: string }} serverInfo
 * @property {string} instructions
 * @property {() => unknown[]} listTools
 * @property {(name: string, args: Record<string, unknown>) => Promise<unknown> | null} callTool  null: no such tool (-32602).
 * @property {(line: string) => void} [log]
 */

/**
 * @param {ProtocolOptions} o
 * @returns {{ handle: (msg: unknown) => Promise<Record<string, unknown> | null> }}
 */
export function createProtocol(o) {
  const log = o.log ?? (() => {});
  /** Request ids a client has cancelled; their result is dropped. @type {Set<string>} */
  const cancelled = new Set();
  /** @param {string | number} id */
  const keyOf = (id) => `${typeof id}:${id}`;

  /** @param {string} method @param {unknown} params @returns {Promise<unknown>} */
  async function dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        if (!isObj(params) || typeof params.protocolVersion !== 'string') throw new RpcError(-32602, 'initialize needs protocolVersion');
        const v = SUPPORTED_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_VERSIONS[0];
        log(`initialize: client ${String(params.clientInfo?.name ?? '?')} asked ${params.protocolVersion}, using ${v}`);
        return { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: o.serverInfo, instructions: o.instructions };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: o.listTools() };
      case 'tools/call': {
        if (!isObj(params) || typeof params.name !== 'string') throw new RpcError(-32602, 'tools/call needs a tool name');
        const args = params.arguments ?? {};
        if (!isObj(args)) throw new RpcError(-32602, 'arguments must be an object');
        const run = o.callTool(params.name, args);
        if (run === null) throw new RpcError(-32602, `unknown tool: ${params.name}`);
        return run;
      }
      default: throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  /**
   * One message in, the response (null for a notification, or when the request was cancelled).
   * @param {unknown} msg
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function handle(msg) {
    if (!isObj(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || ('id' in msg && !isId(msg.id))) {
      return { jsonrpc: '2.0', id: isObj(msg) && isId(msg.id) ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
    }
    const note = !('id' in msg);
    if (note) {
      if (msg.method === 'notifications/cancelled' && isObj(msg.params) && isId(msg.params.requestId)) cancelled.add(keyOf(msg.params.requestId));
      return null;   // every notification is accepted and ignored
    }
    const id = /** @type {string | number} */ (msg.id);
    try {
      const result = await dispatch(msg.method, msg.params);
      if (cancelled.delete(keyOf(id))) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      if (cancelled.delete(keyOf(id))) return null;
      const rpc = e instanceof RpcError;
      if (!rpc) log(`internal error: ${/** @type {Error} */ (e)?.stack ?? e}`);
      return { jsonrpc: '2.0', id, error: { code: rpc ? e.code : -32603, message: rpc ? e.message : 'internal error' } };
    }
  }
  return { handle };
}

/**
 * Read newline-delimited lines from a stream with a byte cap per line. A line over the cap is reported once (`onOverflow`)
 * and dropped up to its newline. Returns a function that stops reading.
 * @param {NodeJS.ReadableStream} input
 * @param {{ onLine: (line: string) => void, onOverflow: () => void, onEnd: () => void, maxBytes?: number }} h
 * @returns {() => void}
 */
export function readLines(input, h) {
  const max = h.maxBytes ?? MAX_LINE_BYTES;
  /** @type {Buffer[]} */
  let chunks = [];
  let size = 0;
  let overflow = false;
  let stopped = false;
  /** @param {Buffer} part @param {boolean} ends */
  const take = (part, ends) => {
    if (overflow) { if (ends) { overflow = false; } return; }
    if (size + part.length > max) { overflow = !ends; chunks = []; size = 0; h.onOverflow(); return; }
    chunks.push(part); size += part.length;
    if (ends) { const line = Buffer.concat(chunks).toString('utf8'); chunks = []; size = 0; if (line.trim()) h.onLine(line); }
  };
  /** @param {Buffer | string} c */
  const onData = (c) => {
    if (stopped) return;
    const chunk = typeof c === 'string' ? Buffer.from(c) : c;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) { take(chunk.subarray(start), false); break; }
      take(chunk.subarray(start, nl), true);
      start = nl + 1;
    }
  };
  const onEnd = () => { if (stopped) return; if (!overflow && size) take(Buffer.alloc(0), true); stopped = true; h.onEnd(); };
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onEnd);
  return () => { stopped = true; input.off('data', onData); input.off('end', onEnd); input.off('close', onEnd); };
}

/**
 * Serve one connection: read lines, answer concurrently, and finish when the input ends or `signal` aborts, after the
 * in-flight requests settle (at most `graceMs`).
 * @param {{ input: NodeJS.ReadableStream, write: (s: string) => unknown, protocol: ReturnType<typeof createProtocol>, signal?: AbortSignal, graceMs?: number, maxLineBytes?: number }} o
 * @returns {Promise<void>}
 */
export function serve(o) {
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  /** @param {unknown} v */
  const send = (v) => { o.write(`${JSON.stringify(v)}\n`); };
  return new Promise((resolve) => {
    /** @param {string} line */
    const onLine = (line) => {
      const p = (async () => {
        /** @type {unknown} */
        let msg;
        try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
        if (Array.isArray(msg)) {   // a JSON-RPC batch (2025-03-26 allowed it): answered as a batch
          if (!msg.length) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }); return; }
          const out = (await Promise.all(msg.map((m) => o.protocol.handle(m)))).filter(Boolean);
          if (out.length) send(out);
          return;
        }
        const r = await o.protocol.handle(msg);
        if (r) send(r);
      })().catch(() => {}).finally(() => { pending.delete(p); });
      pending.add(p);
    };
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      stop();
      o.signal?.removeEventListener('abort', finish);
      /** @type {NodeJS.Timeout | undefined} */
      let t;
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => { t = setTimeout(r, o.graceMs ?? 5000); })]);
      clearTimeout(t);
      resolve();
    };
    const stop = readLines(o.input, {
      onLine, onEnd: finish, maxBytes: o.maxLineBytes,
      onOverflow: () => send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request too large' } }),
    });
    if (o.signal?.aborted) void finish(); else o.signal?.addEventListener('abort', finish, { once: true });
  });
}
