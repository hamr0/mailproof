// TEST-ONLY. A small IMAP4rev1 server on node:tls for exercising src/proof/imap.js (real imapflow) end to end.
// It logs every command, checks credentials exactly, and can drop the socket, lie about sizes, send a short or
// oversized literal and change UIDVALIDITY. The throwaway certificate is generated with openssl at test time into a
// makeTmpDir directory: no key is ever committed. If openssl is missing this THROWS (a test must fail, not skip).
// NEVER imported from src/.
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeTmpDir } from './tmp.js';

/** Deterministic bytes for generated (huge) messages, so the expected hash needs no stored copy. */
export const genByte = (/** @type {number} */ i) => (i * 31 + 7) & 0xff;
export function genChunk(/** @type {number} */ start, /** @type {number} */ len) {
  const b = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) b[i] = genByte(start + i);
  return b;
}
export function genSha256(/** @type {number} */ size) {
  const h = crypto.createHash('sha256');
  for (let o = 0; o < size; o += 1 << 20) h.update(genChunk(o, Math.min(1 << 20, size - o)));
  return h.digest('hex');
}

/** Make a self-signed certificate for `san` (e.g. 'DNS:localhost,IP:127.0.0.1'). Fails loudly without openssl. */
export function makeCert(san = 'DNS:localhost,IP:127.0.0.1') {
  const dir = makeTmpDir('mp-cert-');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=mailproof-test', '-addext', `subjectAltName=${san}`], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`openssl is required to generate the test certificate: ${/** @type {Error} */ (e).message}`);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const quote = (/** @type {string} */ s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * @typedef {Object} FakeMsg
 * @property {number} uid
 * @property {Buffer} [raw]
 * @property {number} [genSize]  Generated content of this many bytes instead of `raw`.
 * @property {number} [announcedSize]  RFC822.SIZE to announce (a lie).
 * @property {'short' | 'ignore-partial'} [fault]  `short`: announce the literal, send half, close. `ignore-partial`: send the whole message whatever range was asked.
 */

/**
 * @param {Object} cfg
 * @param {Record<string, { uidvalidity?: string, uidNext?: number, msgs: FakeMsg[], flags?: string[] }>} cfg.folders
 * @param {{ pass?: string, token?: string, user?: string }} [cfg.creds]
 * @param {string[]} [cfg.caps]  Extra capabilities (default AUTH=PLAIN AUTH=XOAUTH2).
 * @param {{ key: Buffer, cert: Buffer } | null} [cfg.tls]  null: speak plain text (no TLS).
 * @param {(cmd: string, line: string, sock: import('node:net').Socket, n: number) => boolean | void} [cfg.onCommand]  Return true to take the command over (e.g. destroy the socket).
 */
export async function startFakeImap(cfg) {
  const creds = { user: 'acct.owner@account.test', pass: 'Sup3r-Secret-App-Pass-7f3a', token: 'ya29.fake-access-token-9c1', ...cfg.creds };
  const caps = ['IMAP4rev1', 'ID', 'SPECIAL-USE', ...(cfg.caps ?? ['AUTH=PLAIN', 'AUTH=XOAUTH2'])];
  /** @type {Array<{ cmd: string, line: string }>} */
  const log = [];
  const uidvalidity = Object.fromEntries(Object.entries(cfg.folders).map(([p, f]) => [p, f.uidvalidity ?? '1']));
  let connections = 0;
  const counts = new Map();

  const handler = (/** @type {import('node:net').Socket} */ sock) => {
    connections++;
    let buf = '';
    let selected = null;
    let pending = null; // an AUTHENTICATE waiting for its continuation line
    sock.on('error', () => {});
    const send = (/** @type {string} */ s) => sock.write(s + '\r\n');
    send('* OK [CAPABILITY ' + caps.join(' ') + '] fake IMAP ready');

    const finishAuth = (/** @type {string} */ tag, /** @type {boolean} */ ok) => {
      if (ok) send(`${tag} OK [CAPABILITY ${caps.join(' ')}] authenticated`);
      else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
    };

    const writeLiteral = async (/** @type {() => AsyncGenerator<Buffer>} */ gen) => {
      for await (const chunk of gen()) {
        if (!sock.write(chunk)) await new Promise((r) => sock.once('drain', r));
      }
    };

    const fetchCmd = async (/** @type {string} */ tag, /** @type {string} */ line) => {
      const m = /^UID FETCH (\S+) \((.*)\)$/i.exec(line);
      if (!m || !selected) { send(`${tag} BAD bad fetch`); return; }
      const f = cfg.folders[selected];
      const [loS, hiS] = m[1].split(':');
      const lo = Number(loS);
      const hi = hiS === undefined ? lo : (hiS === '*' ? Infinity : Number(hiS));
      const items = m[2];
      const wantSize = /RFC822\.SIZE/i.test(items);
      const body = /BODY(?:\.PEEK)?\[\](?:<(\d+)\.(\d+)>)?/i.exec(items);
      const hits = f.msgs.filter((x) => x.uid >= lo && x.uid <= hi);
      let seq = 0;
      for (const msg of f.msgs) {
        seq++;
        if (!hits.includes(msg)) continue;
        const total = msg.genSize ?? msg.raw?.length ?? 0;
        let head = `* ${seq} FETCH (UID ${msg.uid}`;
        if (wantSize) head += ` RFC822.SIZE ${msg.announcedSize ?? total}`;
        if (!body) { send(head + ')'); continue; }
        const start = body[1] !== undefined ? Number(body[1]) : 0;
        const asked = body[2] !== undefined ? Number(body[2]) : Infinity;
        const from = msg.fault === 'ignore-partial' ? 0 : start;
        const to = msg.fault === 'ignore-partial' ? total : Math.min(total, start + asked);
        const len = Math.max(0, to - from);
        const origin = body[1] !== undefined ? `<${msg.fault === 'ignore-partial' ? 0 : start}>` : '';
        sock.write(`${head} BODY[]${origin} {${len}}\r\n`);
        const send_ = msg.fault === 'short' ? Math.floor(len / 2) : len;
        await writeLiteral(async function* () {
          for (let o = 0; o < send_; o += 1 << 20) {
            const n = Math.min(1 << 20, send_ - o);
            yield msg.genSize !== undefined ? genChunk(from + o, n) : /** @type {Buffer} */ (msg.raw).subarray(from + o, from + o + n);
          }
        });
        if (msg.fault === 'short') { sock.destroy(); return; }
        send(')');
      }
      send(`${tag} OK UID FETCH completed`);
    };

    const onLine = async (/** @type {string} */ line) => {
      if (pending) {
        const p = pending; pending = null;
        const payload = Buffer.from(line.trim(), 'base64');
        if (p.mech === 'XOAUTH2') {
          const ok = payload.toString() === `user=${creds.user}\x01auth=Bearer ${creds.token}\x01\x01`;
          log.push({ cmd: 'AUTH-RESPONSE', line: ok ? 'xoauth2 ok' : 'xoauth2 bad' });
          if (ok) finishAuth(p.tag, true);
          else { send('+ ' + Buffer.from('{"status":"400"}').toString('base64')); pending = { tag: p.tag, mech: 'XOAUTH2-ERR' }; }
          return;
        }
        if (p.mech === 'XOAUTH2-ERR') { finishAuth(p.tag, false); return; }
        const parts = payload.toString().split('\0');
        const ok = parts[1] === creds.user && parts[2] === creds.pass;
        log.push({ cmd: 'AUTH-RESPONSE', line: ok ? 'plain ok' : 'plain bad' });
        finishAuth(p.tag, ok);
        return;
      }
      const m = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
      if (!m) { send('* BAD parse'); return; }
      const [, tag, verb, rest = ''] = m;
      let cmd = verb.toUpperCase();
      if (cmd === 'UID') cmd = `UID ${rest.split(' ')[0].toUpperCase()}`;
      log.push({ cmd, line });
      counts.set(cmd, (counts.get(cmd) ?? 0) + 1);
      if (cfg.onCommand?.(cmd, line, sock, counts.get(cmd))) return;
      switch (cmd) {
        case 'CAPABILITY': send('* CAPABILITY ' + caps.join(' ')); send(`${tag} OK done`); break;
        case 'ID': send('* ID ("name" "fake-imap")'); send(`${tag} OK done`); break;
        case 'NAMESPACE': send('* NAMESPACE (("" "/")) NIL NIL'); send(`${tag} OK done`); break;
        case 'NOOP': send(`${tag} OK done`); break;
        case 'LOGOUT': send('* BYE bye'); send(`${tag} OK done`); sock.end(); break;
        case 'LOGIN': {
          const q = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => (x[1] ?? x[2]).replace(/\\(.)/g, '$1'));
          finishAuth(tag, q[0] === creds.user && q[1] === creds.pass);
          break;
        }
        case 'AUTHENTICATE': {
          const [mech, ir] = rest.split(' ');
          const M = mech.toUpperCase();
          if (ir) { pending = { tag, mech: M }; await onLine(ir); } else { pending = { tag, mech: M }; send('+ '); }
          break;
        }
        case 'LSUB': case 'LIST': {
          const arg = /^"" (?:"((?:[^"\\]|\\.)*)"|(\S+))/.exec(rest);
          const pattern = arg ? (arg[1] ?? arg[2]) : '*';
          for (const [p, f] of Object.entries(cfg.folders)) {
            if (pattern !== '*' && pattern !== '%' && pattern !== p) continue;
            send(`* ${cmd} (${(f.flags ?? ['\\HasNoChildren']).join(' ')}) "/" ${quote(p)}`);
          }
          send(`${tag} OK ${cmd} done`);
          break;
        }
        case 'EXAMINE': case 'SELECT': {
          const name = /^"((?:[^"\\]|\\.)*)"|^(\S+)/.exec(rest);
          const p = (name?.[1] ?? name?.[2] ?? '').replace(/\\(.)/g, '$1');
          const f = cfg.folders[p];
          if (!f) { send(`${tag} NO [NONEXISTENT] Unknown Mailbox`); break; }
          selected = p;
          const max = f.msgs.reduce((a, x) => Math.max(a, x.uid), 0);
          send(`* ${f.msgs.length} EXISTS`); send('* 0 RECENT'); send('* FLAGS (\\Seen \\Answered)');
          send(`* OK [UIDVALIDITY ${uidvalidity[p]}] UIDs valid`); send(`* OK [UIDNEXT ${f.uidNext ?? max + 1}] Predicted next UID`);
          send(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} completed`);
          break;
        }
        case 'UID FETCH': await fetchCmd(tag, line.slice(tag.length + 1)); break;
        default: send(`${tag} BAD unknown or unsupported command`);
      }
    };

    let chain = Promise.resolve();
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        chain = chain.then(() => onLine(line)).catch(() => sock.destroy());
      }
    });
  };

  const server = cfg.tls === null ? net.createServer(handler) : tls.createServer({ ...(cfg.tls ?? makeCert()), minVersion: 'TLSv1.2' }, handler);
  server.on('tlsClientError', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return {
    port, log, creds, uidvalidity, folders: cfg.folders,
    connections: () => connections,
    commands: () => log.map((l) => l.cmd),
    close: () => new Promise((r) => { server.close(() => r(undefined)); server.closeAllConnections?.(); }),
  };
}
