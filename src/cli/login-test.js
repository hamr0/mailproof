// The wizard's "test login now" (SPEC B11.12): ONE real IMAP login and a folder status through the library's own imap module (`openSession`,
// read-only like every mailproof session), so a wrong password or a mistyped folder shows up before the config is written. Nothing is
// selected for writing, nothing is fetched or recorded. The count of a folder is its highest UID (`UIDNEXT - 1`), an upper bound on the
// messages in it, which is all a status needs. Tests inject `deps.testLogin` instead: IMAP is never contacted from a test.

import { SYNC_CONNECT_MS, SYNC_SOCKET_MS } from '../proof/limits.js';

/**
 * @param {{ host: string, port: number, user: string, auth: { pass: string } | { accessToken: string }, folders: string[], sent: boolean | string }} o
 * @returns {Promise<{ ok: true, folders: Array<{ folder: string, count: number }> } | { ok: false, code: string, message: string }>}
 */
export async function testLogin(o) {
  const { openSession } = await import('../proof/imap.js');
  /** @type {Awaited<ReturnType<typeof openSession>>} */
  let s;
  try { s = await openSession({ host: o.host, port: o.port, user: o.user, auth: o.auth, timeouts: { connectMs: SYNC_CONNECT_MS, socketMs: SYNC_SOCKET_MS } }); }
  catch (e) { const x = /** @type {{ code?: string, message?: string }} */ (e); return { ok: false, code: x.code ?? 'ERR_IMAP', message: x.message ?? 'login failed' }; }
  try {
    /** @type {Array<{ folder: string, count: number }>} */
    const folders = [];
    const names = [...o.folders];
    if (o.sent === true) { const sent = await s.findSent().catch(() => null); if (sent) names.push(sent); } else if (typeof o.sent === 'string') names.push(o.sent);
    for (const folder of names) {
      const sel = await s.select(folder);
      folders.push({ folder, count: sel.uidNext - 1 });
    }
    return { ok: true, folders };
  } catch (e) {
    const x = /** @type {{ code?: string, message?: string }} */ (e);
    return { ok: false, code: x.code ?? 'ERR_IMAP', message: x.message ?? 'the folder check failed' };
  } finally { await s.close(); }
}
