// Offline DKIM re-check from a stored record ALONE: no raw email, no DNS, no
// live mailauth call. Canonicalisation comes from mailauth (vetted), the
// signature check from Node's crypto. Time semantics (findings F2): `x=` and
// `t=` are judged as of the record's capture time, not "now", and an unusable
// capture time fails closed.

import crypto from 'node:crypto';
import { generateCanonicalizedHeader } from 'mailauth/lib/dkim/header';
import { dkimBody } from 'mailauth/lib/dkim/body';
import { parseTags, canonPair, splitMessage } from './signed-headers.js';
import { getAlignment } from 'mailauth/lib/tools';
import { hashDocument } from './hash.js';

/** @typedef {import('./types.js').MpRecord} MpRecord */
/** @typedef {import('./types.js').RecordSignature} RecordSignature */

const FUTURE_T_SKEW_S = 300;

/**
 * @param {{ k?: string, p?: string }} key
 * @returns {crypto.KeyObject}
 */
function keyObject(key) {
  const der = Buffer.from(key.p || '', 'base64');
  if ((key.k || 'rsa').toLowerCase() === 'ed25519') {
    return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), der]), format: 'der', type: 'spki' });
  }
  try { return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }); }
  catch { return crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' }); }
}

/**
 * Resolve the `at` option (Date | ms | ISO string) to epoch ms, or NaN.
 * @param {Date | number | string | null | undefined} at
 * @returns {number}
 */
function toMs(at) {
  if (at instanceof Date) return at.getTime();
  if (typeof at === 'number') return at;
  if (typeof at === 'string' && at.trim()) return Date.parse(at);
  return NaN;
}

/**
 * Re-check ONE stored signature. Never throws.
 * @param {RecordSignature} sig
 * @param {number} atMs  Epoch ms the signature is judged at (NaN fails closed).
 * @param {number} nowMs
 * @returns {{ ok: boolean, why: string, expires: number | null, expired_now: boolean, canon?: Buffer }}
 */
function verifySignature(sig, atMs, nowMs) {
  try {
    const sigRaw = Buffer.from(sig.dkim_signature, 'base64');
    const tags = parseTags(sigRaw.toString('binary'));
    const expires = tags.x ? Number(tags.x) : null;
    const expired_now = expires !== null && nowMs / 1000 > expires;
    if (!sig.key || !sig.key.p) return { ok: false, why: 'no archived key', expires, expired_now };
    const [alg, hash] = (tags.a || '').toLowerCase().split('-');
    if (hash !== 'sha256' || !['rsa', 'ed25519'].includes(alg)) {
      return { ok: false, why: `unsupported a=${tags.a}`, expires, expired_now };
    }
    const c = canonPair(tags.c);
    const lines = sig.signed_headers.map((x) => ({ line: Buffer.from(x, 'base64') }));
    const { canonicalizedHeader } = generateCanonicalizedHeader(
      'DKIM', { keys: tags.h || '', headers: lines }, { signatureHeaderLine: sigRaw, canonicalization: `${c.h}/${c.b}` },
    );
    const bytes = Buffer.from(canonicalizedHeader);
    const bsig = Buffer.from((tags.b || '').replace(/\s+/g, ''), 'base64');
    const pub = keyObject(sig.key);
    const valid = alg === 'rsa'
      ? crypto.verify('sha256', bytes, pub, bsig)
      : crypto.verify(null, crypto.createHash('sha256').update(bytes).digest(), pub, bsig);
    if (!valid) return { ok: false, why: 'bad signature', expires, expired_now, canon: bytes };
    if (!Number.isFinite(atMs)) return { ok: false, why: 'no usable capture time', expires, expired_now, canon: bytes };
    const atS = atMs / 1000;
    if (expires !== null && atS > expires) return { ok: false, why: 'expired', expires, expired_now, canon: bytes };
    if (tags.t && Number(tags.t) > atS + FUTURE_T_SKEW_S) {
      return { ok: false, why: 'timestamp in future', expires, expired_now, canon: bytes };
    }
    return { ok: true, why: '', expires, expired_now, canon: bytes };
  } catch (e) {
    return { ok: false, why: 'error: ' + (e instanceof Error ? e.message : String(e)), expires: null, expired_now: false };
  }
}

/**
 * The single author domain of the signed `From:` line, or null when the line is
 * missing/ambiguous (a signature that does not cover From can never align).
 * @param {RecordSignature} sig
 * @returns {string | null}
 */
function signedFromDomain(sig) {
  try {
    const line = sig.signed_headers.map((x) => Buffer.from(x, 'base64').toString('binary')).find((l) => /^from\s*:/i.test(l));
    if (!line) return null;
    const addrs = line.slice(line.indexOf(':') + 1).match(/[^\s<>,;"()]+@[^\s<>,;"()]+/g) || [];
    const domains = new Set(addrs.map((a) => a.slice(a.lastIndexOf('@') + 1).toLowerCase()));
    return domains.size === 1 ? [...domains][0] : null;
  } catch { return null; }
}

/**
 * @param {RecordSignature} sig
 * @param {string | undefined} d  The signature's d= domain.
 * @param {boolean} strict  adkim=s from the stored DMARC record.
 * @returns {boolean}
 */
function fromDomainAligned(sig, d, strict) {
  const from = signedFromDomain(sig);
  return Boolean(from && d && getAlignment(from, d, strict));
}

/**
 * Offline re-check of a stored record (JSON object or string). Pure and sync.
 * `at` defaults to `record.captured`; a missing or garbled `captured` fails
 * every signature closed. Never throws.
 * @param {MpRecord | string} recordOrJson
 * @param {{ at?: Date | number | string, now?: number }} [opts]
 * @returns {{ ok: boolean, trust: 'verified' | 'unverified', basis: 'dkim' | 'none', passing: number[], at: string | null, signatures: Array<{ index: number, d: string | null, s: string | null, ok: boolean, aligned: boolean, why: string, expires: number | null, expired_now: boolean, partial_body: boolean }> }}
 */
function verifyRecord(recordOrJson, opts = {}) {
  /** @type {MpRecord | null} */
  let rec = null;
  try { rec = typeof recordOrJson === 'string' ? JSON.parse(recordOrJson) : recordOrJson; } catch { rec = null; }
  if (!rec || rec.v !== 2 || !Array.isArray(rec.signatures)) {
    return { ok: false, trust: 'unverified', basis: 'none', passing: [], at: null, signatures: [] };
  }
  const strict = /\badkim\s*=\s*s\b/i.test(String(rec.verdicts?.live?.dmarc?.rr || ''));
  const atMs = opts.at !== undefined ? toMs(opts.at) : toMs(rec.captured);
  const nowMs = opts.now ?? Date.now();
  const signatures = rec.signatures.map((sig, index) => {
    const r = verifySignature(sig, atMs, nowMs);
    let tags = {};
    try { tags = parseTags(Buffer.from(sig.dkim_signature, 'base64').toString('binary')); } catch { /* fail closed above */ }
    return {
      index, d: /** @type {any} */ (tags).d ?? null, s: /** @type {any} */ (tags).s ?? null,
      ok: r.ok, aligned: r.ok && fromDomainAligned(sig, /** @type {any} */ (tags).d, strict), why: r.why, expires: r.expires, expired_now: r.expired_now, partial_body: !!sig.partial_body,
    };
  });
  const passing = signatures.filter((x) => x.ok && x.aligned).map((x) => x.index);
  return {
    ok: signatures.some((s) => s.ok),
    trust: passing.length ? 'verified' : 'unverified',
    basis: passing.length ? 'dkim' : 'none',
    passing,
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
    signatures,
  };
}

/**
 * Does `body` hash to this signature's `bh=`? (Uses the stored signature's own
 * c=, a= and l= tags, so it is not fooled by edited informational fields.)
 * @param {RecordSignature} sig
 * @param {Buffer} body
 * @returns {boolean}
 */
function bodyMatchesSignature(sig, body) {
  try {
    const t = parseTags(Buffer.from(sig.dkim_signature, 'base64').toString('binary'));
    const h = dkimBody(canonPair(t.c).b, (t.a || '').split('-').pop(), t.l ? Number(t.l) : false);
    h.update(body);
    return h.digest('base64') === (t.bh || '').replace(/\s+/g, '');
  } catch { return false; }
}

/**
 * Body-match: hash a raw email's body against each stored signature's `bh=`.
 * `full` is true when some signature both verifies at capture time and matches.
 * @param {MpRecord} rec
 * @param {Buffer | string} raw
 * @param {{ at?: Date | number | string }} [opts]
 * @returns {{ match: boolean, full: boolean, signatures: Array<{ index: number, d: string | null, s: string | null, match: boolean }> }}
 */
function matchBodyRecord(rec, raw, opts = {}) {
  const verified = verifyRecord(rec, opts);
  /** @type {Buffer} */
  let body;
  try { body = splitMessage(raw).body; } catch { body = Buffer.alloc(0); }
  const signatures = (rec.signatures || []).map((sig, index) => ({
    index, d: verified.signatures[index]?.d ?? null, s: verified.signatures[index]?.s ?? null,
    match: bodyMatchesSignature(sig, body),
  }));
  return {
    match: signatures.some((s) => s.match),
    full: signatures.some((s) => s.match && verified.signatures[s.index]?.ok),
    signatures,
  };
}

/**
 * File-match: does `bytes` equal one of the record's attachments by sha256?
 * @param {MpRecord} rec
 * @param {Buffer | Uint8Array | string} bytes
 * @returns {{ match: boolean, attachment: { index: number, filename: string | null, size: number, sha256: string } | null }}
 */
function matchFileRecord(rec, bytes) {
  const want = hashDocument(bytes);
  const index = (rec.attachments || []).findIndex((a) => a && a.sha256 === want);
  if (index < 0) return { match: false, attachment: null };
  const a = rec.attachments[index];
  return { match: true, attachment: { index, filename: a.filename ?? null, size: a.size, sha256: a.sha256 } };
}

export { verifyRecord, verifySignature, matchBodyRecord, matchFileRecord, bodyMatchesSignature };
