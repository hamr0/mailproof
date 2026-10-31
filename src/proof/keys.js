// DKIM public-key archival (verify pillar, durable half). Fetches the TXT
// record at {selector}._domainkey.{domain}, extracts the `p=` base64 key, and
// wraps it in PEM (SubjectPublicKeyInfo) so any third party can re-verify a
// commit's DKIM signature OFFLINE — even after the signer rotates their DNS
// key. ingest() archives this alongside each accepted reply; the verify+ /
// reverify endpoints (m7c) re-check against it.
//
// Runs right after mailauth's own DKIM verification. If DNS rotates between
// mailauth's query and ours (rare — milliseconds apart), the archived key may
// differ; metadata records `fetched_at` so an auditor can tell.
//
// LIFTED FROM gitdone's dkim-archive.js — generic, no policy, no config
// singleton. The resolver is INJECTED (the same custom resolver create() threads
// into mailauth), so tests run offline and the future verify+ endpoint can
// re-check against an archived key. Pure except the DNS lookup.


import { promises as dns } from 'node:dns';

// Parse a DKIM record's `p=` value. DKIM records are semicolon-separated
// tag=value; we only need p (public key). Returns base64 string or null.
/** @typedef {import('./types.js').DkimArchive} DkimArchive */
/** @typedef {import('./types.js').MailauthResult} MailauthResult */

/**
 * Extract a DKIM record's `p=` base64 public key. Pure.
 * @param {string | string[] | null} txtRecord
 * @returns {string | null}
 */
function extractPublicKey(txtRecord) {
  if (!txtRecord) return null;
  const joined = Array.isArray(txtRecord) ? txtRecord.join('') : String(txtRecord);
  for (const chunk of joined.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    const key = chunk.slice(0, eq).trim().toLowerCase();
    if (key === 'p') return chunk.slice(eq + 1).trim().replace(/\s+/g, '');
  }
  return null;
}

// Wrap base64 SubjectPublicKeyInfo bytes into PEM. DKIM records carry RSA public
// keys in SubjectPublicKeyInfo DER; they drop directly under BEGIN/END PUBLIC
// KEY headers (openssl/evp compatible).
/**
 * Wrap base64 SubjectPublicKeyInfo bytes into PEM. Pure.
 * @param {string | null} base64
 * @returns {string | null}
 */
function toPem(base64) {
  if (!base64) return null;
  const lines = [];
  for (let i = 0; i < base64.length; i += 64) lines.push(base64.slice(i, i + 64));
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

/**
 * @param {string} name
 * @returns {Promise<string[][]>}
 */
async function resolveTxt(name) {
  return dns.resolveTxt(name);
}

/**
 * Fetch + PEM-wrap the DKIM public key at `{selector}._domainkey.{domain}`.
 * Never throws; failure is reported in the `error` field. The resolver is
 * injected so tests run offline.
 * @param {string} domain
 * @param {string} selector
 * @param {{ resolver?: (name: string) => Promise<string[][]>, timeoutMs?: number }} [opts]
 * @returns {Promise<DkimArchive>}
 */
async function fetchDkimKey(domain, selector, { resolver = resolveTxt, timeoutMs = 5000 } = {}) {
  if (!domain || !selector) return { pem: null, base64: null, error: 'missing domain/selector' };
  // Defensive input validation: selectors and domains in valid DKIM records are
  // ASCII labels. Reject anything weirder so we can't be coerced into looking up
  // an attacker-controlled hostname.
  if (!/^[a-zA-Z0-9._-]+$/.test(domain) || !/^[a-zA-Z0-9._-]+$/.test(selector)) {
    return { pem: null, base64: null, error: 'invalid domain/selector' };
  }
  const name = `${selector}._domainkey.${domain}`;
  const fetchedAt = new Date().toISOString();
  try {
    const records = await Promise.race([
      resolver(name),
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), timeoutMs)),
    ]);
    if (!records || records.length === 0) {
      return { pem: null, base64: null, error: 'no TXT record', fetched_at: fetchedAt, lookup: name };
    }
    // records is [[chunk1, chunk2, ...], ...]; DKIM is generally a single
    // record — take the first and join its chunks.
    const base64 = extractPublicKey(records[0]);
    if (!base64) return { pem: null, base64: null, error: 'no p= tag', fetched_at: fetchedAt, lookup: name };
    return { pem: toPem(base64), base64, fetched_at: fetchedAt, lookup: name };
  } catch (err) {
    return { pem: null, base64: null, error: (err instanceof Error ? err.message : null) || String(err), fetched_at: fetchedAt, lookup: name };
  }
}

// Given a mailauth result, pick the DKIM signature to archive. Prefer a passing
// + aligned signature; else first passing; else the first present; else null
// (no archive for unsigned mail).
/**
 * Pick the DKIM signature to archive from a mailauth result (prefer pass+aligned,
 * then any pass, then first present, else null). Pure.
 * @param {MailauthResult} auth
 * @returns {Record<string, any> | null}
 */
function pickSignatureToArchive(auth) {
  /** @type {Array<Record<string, any>>} */
  const sigs = (auth && auth.dkim && auth.dkim.results) || [];
  if (sigs.length === 0) return null;
  return (
    sigs.find((s) => s.status && s.status.result === 'pass' && s.status.aligned)
    || sigs.find((s) => s.status && s.status.result === 'pass')
    || sigs[0]
  );
}

export { fetchDkimKey, extractPublicKey, toPem, pickSignatureToArchive };
