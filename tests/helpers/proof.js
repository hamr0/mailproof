// TEST-ONLY helpers for the v2 proof layer: sign synthetic mail with mailauth's
// own dkimSign (RSA or ed25519, any c=, l=, x=, several signatures), plus the
// stub resolver that serves the generated keys. Keys are generated per call, so
// no secret is ever committed. NEVER imported from src/.

import crypto from 'node:crypto';
import { dkimSign } from 'mailauth';
import { splitMessage } from '../../src/proof/signed-headers.js';
import { buildSignatureEntry } from '../../src/proof/record.js';

/** @param {'rsa'|'ed25519'} alg */
function makeKey(alg = 'rsa') {
  if (alg === 'ed25519') {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    return {
      alg, privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      k: 'ed25519', p: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
    };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    alg, privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    k: 'rsa', p: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** mailauth-compatible resolver over a {name: txt} map; missing names throw ENOTFOUND. */
function stubResolver(map, { failDmarcWith = null } = {}) {
  return async (name, type) => {
    if ((type || 'TXT').toUpperCase() !== 'TXT') {
      throw Object.assign(new Error('stub-dns: only TXT'), { code: 'ENODATA' });
    }
    if (failDmarcWith && name.startsWith('_dmarc.')) {
      throw Object.assign(new Error('stub-dns: ' + failDmarcWith), { code: failDmarcWith });
    }
    if (map[name] === undefined) throw Object.assign(new Error('stub-dns: no record for ' + name), { code: 'ENOTFOUND' });
    return [[map[name]]];
  };
}

/**
 * Build + sign a message. `signers` defaults to one signer at `domain`/`selector`.
 * Returns { raw, resolver, signers, domain }. `dmarc`: a TXT string, or null for
 * "no DMARC record published".
 */
async function signedMail({
  domain = 'signer.example', selector = 'sel1', from, to = 'rcpt@other.example',
  subject = 'Re: please sign', body = 'I confirm.\r\n', messageId, inReplyTo, references,
  canon = 'relaxed/relaxed', alg = 'rsa', bodyLength, expires, signTime = new Date(),
  headerList = ['from', 'to', 'subject', 'date', 'message-id'], extraHeaders = [], attachment,
  signers, dmarc = 'v=DMARC1; p=none; adkim=r; aspf=r', dmarcFail = null,
} = {}) {
  from = from || `me@${domain}`;
  const list = signers || [{ domain, selector, alg }];
  const sg = list.map((s) => ({ ...s, key: s.key || makeKey(s.alg || alg) }));
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date(signTime).toUTCString()}`,
    `Message-ID: ${messageId || `<${Date.now()}.${crypto.randomBytes(4).toString('hex')}@${domain}>`}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    ...extraHeaders, 'MIME-Version: 1.0',
  ];
  let msg;
  if (attachment) {
    const bnd = 'bnd' + crypto.randomBytes(4).toString('hex');
    msg = [...lines, `Content-Type: multipart/mixed; boundary="${bnd}"`, '',
      `--${bnd}`, 'Content-Type: text/plain; charset=utf-8', '', body.replace(/\r\n$/, ''),
      `--${bnd}`, `Content-Type: application/octet-stream; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${attachment.filename}"`, '',
      Buffer.from(attachment.bytes).toString('base64'), `--${bnd}--`, ''].join('\r\n');
  } else {
    msg = [...lines, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');
  }
  const res = await dkimSign(Buffer.from(msg), {
    canonicalization: canon, signTime, expires,
    signatureData: sg.map((s) => ({
      signingDomain: s.domain, selector: s.selector, privateKey: s.key.privPem,
      algorithm: s.key.alg === 'ed25519' ? 'ed25519-sha256' : 'rsa-sha256',
      headerList: (s.headerList || headerList).join(':'),
      ...(bodyLength !== undefined ? { maxBodyLength: bodyLength } : {}),
    })),
  });
  if (res.errors && res.errors.length) throw new Error('signedMail: ' + JSON.stringify(res.errors));
  const map = {};
  for (const s of sg) map[`${s.selector}._domainkey.${s.domain}`] = `v=DKIM1; k=${s.key.k}; p=${s.key.p}`;
  if (dmarc) for (const s of new Set([domain, ...sg.map((x) => x.domain)])) map[`_dmarc.${s}`] = dmarc;
  return {
    raw: Buffer.concat([Buffer.from(res.signatures), Buffer.from(msg)]),
    resolver: stubResolver(map, { failDmarcWith: dmarcFail }), signers: sg, domain, map,
  };
}

/** Build a v2-shaped record (signatures only) from raw + the signers' keys. */
function recordOf(raw, signers, { captured = new Date().toISOString() } = {}) {
  const { rows, body } = splitMessage(raw);
  const keyFor = (d, s) => signers.find((x) => x.domain === d && x.selector === s)?.key;
  const signatures = rows.filter((r) => r.name === 'dkim-signature').map((sr) => {
    const t = Object.fromEntries(sr.raw.slice(sr.raw.indexOf(':') + 1).split(';').map((x) => x.split('=').map((y) => y.trim())).filter((a) => a[0]));
    const key = keyFor(t.d, t.s);
    return buildSignatureEntry(rows, sr, body, { key: key ? { k: key.k, p: key.p } : null });
  });
  return { v: 2, id: 'x'.repeat(32), captured, direction: 'in', source: 'test', message: {}, attachments: [], signatures, verdicts: {}, ots: null };
}

export { makeKey, stubResolver, signedMail, recordOf };
