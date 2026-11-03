// The only module that imports imapflow (SPEC B4.6). It turns imapflow into the small plain-data session sync.js
// works against: no BigInt, no stream and no imapflow type leaves this file. The settings that matter for safety
// are fixed here and are not options: implicit TLS with certificate checking always on (only `tls.ca` can be
// added), logging off (a log is where a credential or message text would leak), no compression (wire bytes must be
// literal bytes), no background IDLE, and a literal-size cap so a hostile server cannot make us buffer more than the
// gate limit plus a small margin. Every mailbox is opened read-only (EXAMINE) and read with BODY.PEEK[].

import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { MAX_TOTAL_BYTES } from './limits.js';

/** @typedef {import('./sync.js').ImapSession} ImapSession */
/** @typedef {import('./sync.js').OpenSessionArgs} OpenSessionArgs */

/** Bytes per `BODY.PEEK[]<start.n>` request when a message is streamed through a hash. */
const HASH_CHUNK_BYTES = 2 * 1024 * 1024;
/** Largest literal imapflow will accept: the biggest buffered read (gate limit + 1) plus room for response framing. */
const MAX_LITERAL_BYTES = MAX_TOTAL_BYTES + 1 + 64 * 1024;
const LOGOUT_WAIT_MS = 5000;

/** Node and imapflow codes that mean the connection is gone or never came up: a reconnect may help. */
const CONNECTION_CODES = new Set([
  'NoConnection', 'EConnectionClosed', 'StateLogout', 'ClosedAfterConnectText', 'ClosedAfterConnectTLS', 'DownloadIncomplete',
  'ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
]);
const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);

/**
 * @param {string} code @param {string} message @param {boolean} retryable
 * @returns {Error & { code: string, retryable: boolean }}
 */
const imapError = (code, message, retryable) => Object.assign(new Error(message), { code, retryable });

/**
 * Turn anything imapflow (or the socket) throws into one of our errors. Messages are fixed text plus the library's
 * short error code: server-sent text and the library's own messages are never copied, so a credential or message
 * content cannot ride along in one.
 * @param {unknown} err
 * @param {boolean} connecting  True while logging in: anything that is not a refused login is a connection failure.
 * @returns {Error & { code: string, retryable: boolean }}
 */
function classifyImapError(err, connecting) {
  const e = /** @type {Record<string, any>} */ (err && typeof err === 'object' ? err : {});
  const code = typeof e.code === 'string' ? e.code.slice(0, 60) : '';
  const tag = code ? ` (${code})` : '';
  if (e.authenticationFailed) return imapError('ERR_IMAP_AUTH', 'login refused by the server', false);
  if (connecting) return imapError('ERR_IMAP_CONNECT', `cannot connect to the server${tag}`, false);
  if (e.mailboxMissing) return imapError('ERR_IMAP_NO_FOLDER', 'no such folder', false);
  const text = `${e.serverResponseCode ?? ''} ${e.responseText ?? ''}`;
  if (code === 'ETHROTTLE' || /THROTTLED|bandwidth limit|too many (commands|connections)/i.test(text)) {
    return imapError('ERR_IMAP_THROTTLED', 'the server is throttling this account', false);
  }
  if (TIMEOUT_CODES.has(code)) return imapError('ERR_IMAP_TIMEOUT', `the server did not answer in time${tag}`, true);
  if (CONNECTION_CODES.has(code)) return imapError('ERR_IMAP_PROTOCOL', `the connection was lost${tag}`, true);
  return imapError('ERR_IMAP_PROTOCOL', `unexpected server response${tag}`, false);
}

/**
 * Open a read-only IMAP session (SPEC B4.6).
 * @param {OpenSessionArgs} args
 * @returns {Promise<ImapSession>}
 * @throws {Error & { code: 'ERR_IMAP_AUTH' | 'ERR_IMAP_CONNECT' }}
 */
async function openSession({ host, port, user, auth, tls, timeouts }) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: 'pass' in auth ? { user, pass: auth.pass } : { user, accessToken: auth.accessToken },
    tls: { ...(tls?.ca !== undefined ? { ca: tls.ca } : {}), rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false,
    emitLogs: false,
    disableCompression: true,
    disableAutoIdle: true,
    disableAutoEnable: true,
    maxLiteralSize: MAX_LITERAL_BYTES,
    connectionTimeout: timeouts.connectMs,
    greetingTimeout: timeouts.connectMs,
    socketTimeout: timeouts.socketMs,
  });
  // imapflow reports a socket failure as an 'error' event; with no listener Node would throw it as uncaught
  client.on('error', () => {});

  try { await client.connect(); }
  catch (err) {
    try { client.close(); } catch { /* already down */ }
    throw classifyImapError(err, true);
  }

  /** @type {{ release: () => void } | null} */
  let lock = null;
  const release = () => { const l = lock; lock = null; try { l?.release(); } catch { /* connection gone */ } };

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const guard = async (fn) => {
    try { return await fn(); } catch (err) { throw classifyImapError(err, false); }
  };

  return {
    async findSent() {
      return guard(async () => {
        const boxes = await client.list();
        const sent = boxes.find((b) => b.specialUse === '\\Sent');
        return sent ? sent.path : null;
      });
    },

    async select(path) {
      release();
      return guard(async () => {
        lock = await client.getMailboxLock(path, { readOnly: true });
        const mb = client.mailbox;
        if (!mb || typeof mb === 'boolean') throw imapError('ERR_IMAP_PROTOCOL', 'the folder did not open', false);
        const uidNext = Number(mb.uidNext);
        if (mb.uidValidity === undefined || !Number.isSafeInteger(uidNext) || uidNext < 1) {
          throw imapError('ERR_IMAP_PROTOCOL', 'the server did not report UIDVALIDITY and UIDNEXT', false);
        }
        return { uidvalidity: String(mb.uidValidity), uidNext }; // a BigInt in imapflow: a decimal string from here on
      });
    },

    async list(lo, hi) {
      return guard(async () => {
        if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 1 || hi < lo) throw imapError('ERR_IMAP_PROTOCOL', 'bad UID range', false);
        /** @type {Array<{ uid: number, size: number }>} */
        const out = [];
        // An explicit range, never `*`. Rows outside it are dropped and at most the range's width is kept, whatever the server sends.
        for await (const m of client.fetch(`${lo}:${hi}`, { uid: true, size: true }, { uid: true })) {
          if (m.uid >= lo && m.uid <= hi && out.length < hi - lo + 1) out.push({ uid: m.uid, size: Number(m.size) });
        }
        return out;
      });
    },

    async fetch(uid, max) {
      return guard(async () => {
        const m = await client.fetchOne(String(uid), { uid: true, source: { start: 0, maxLength: max } }, { uid: true });
        if (!m || !m.source) return Buffer.alloc(0); // gone since it was listed
        return m.source.length > max ? m.source.subarray(0, max) : m.source; // a server may ignore the partial range: never return more than asked
      });
    },

    async hash(uid, max = Infinity) {
      // Chunk by chunk with our own loop (not imapflow's download()): download() stops a message at twice the size
      // the server announced, which would refuse the very message whose announced size is a lie. The cap is ours.
      return guard(async () => {
        const h = crypto.createHash('sha256');
        let size = 0;
        for (;;) {
          const m = await client.fetchOne(String(uid), { uid: true, source: { start: size, maxLength: HASH_CHUNK_BYTES } }, { uid: true });
          const chunk = m && m.source ? m.source : null;
          if (!chunk || chunk.length === 0) break; // end of the message (or it is gone)
          if (chunk.length > HASH_CHUNK_BYTES) throw imapError('ERR_IMAP_PROTOCOL', 'the server ignored the requested byte range', false);
          size += chunk.length;
          if (size > max) return { sha256: null, size, over: true };
          h.update(chunk);
          if (chunk.length < HASH_CHUNK_BYTES) break;
        }
        return { sha256: h.digest('hex'), size, over: false };
      });
    },

    async close() {
      release();
      try {
        await Promise.race([
          client.logout(),
          new Promise((resolve) => { setTimeout(resolve, LOGOUT_WAIT_MS).unref(); }),
        ]);
      } catch { /* the connection is already gone */ }
      try { client.close(); } catch { /* already closed */ }
    },
  };
}

export { openSession, classifyImapError };
