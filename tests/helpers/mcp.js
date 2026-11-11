// TEST-ONLY. Drivers for the MCP server: in-process (`createMcp`, no streams) and spawned (`mailproof mcp` over real pipes).
// NEVER imported from src/.
import { spawn } from 'node:child_process';
import { loadConfig } from '../../src/cli/config.js';
import { createMcp } from '../../src/mcp/server.js';
import { BIN } from './cli.js';

let n = 100;
const rpcOf = (method, params) => ({ jsonrpc: '2.0', id: ++n, method, params });

/** The parts of a tools/call response a test reads. */
export function shape(r) {
  if (r.error) return { protocolError: r.error };
  const res = r.result;
  const text = res.content.find((c) => c.type === 'text')?.text;
  return { isError: res.isError, content: res.content, text, json: text === undefined ? undefined : JSON.parse(text), error: res.isError ? JSON.parse(text).error : undefined };
}

/** In-process: one `createMcp` over a world's config. `call(name, args)` returns `shape()` of the response. */
export async function inProcess(world, { deps = {}, accountFlag, afterPathCheck } = {}) {
  const config = await loadConfig(world.configFile, world.env);
  const mcp = createMcp({ config, accountFlag, env: world.env, deps, version: 'test', configFile: world.configFile, afterPathCheck });
  return {
    mcp,
    request: (method, params) => mcp.protocol.handle(rpcOf(method, params)),
    call: async (name, args = {}) => shape(await mcp.protocol.handle(rpcOf('tools/call', { name, arguments: args }))),
    close: () => mcp.closeAll(),
  };
}

/** A spawned `mailproof mcp`: line-by-line replies, `rpc()` sends one message and awaits one reply. */
export function spawnMcp(world, { args = [], env: extra = {}, t } = {}) {
  const child = spawn(process.execPath, [BIN, 'mcp', ...args], { env: { ...world.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  t?.after(() => { child.kill('SIGKILL'); });   // a failed assertion must not leave the server running (it would hang the test run)
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
  const waiters = []; let buf = ''; const stdoutLines = [];
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); stdoutLines.push(l); waiters.shift()?.(l); }
  });
  const nextLine = () => new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('timeout waiting for a reply')), 30000); waiters.push((l) => { clearTimeout(to); res(l); }); });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  const rpc = async (o) => { const p = nextLine(); child.stdin.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`); return JSON.parse(await p); };
  return {
    child, stdoutLines, exited, rpc, get stderr() { return stderr; },
    send: (o) => child.stdin.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`),
    request: (method, params) => rpc(rpcOf(method, params)),
    call: async (name, args = {}) => shape(await rpc(rpcOf('tools/call', { name, arguments: args }))),
    init: (v = '2025-11-25') => rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    end: () => child.stdin.end(),
    kill: () => child.kill('SIGKILL'),
  };
}
