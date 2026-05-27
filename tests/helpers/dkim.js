'use strict';

// TEST-ONLY DKIM helpers. Sign a synthesized .eml with mailauth's own dkimSign
// and build a matching in-process DNS resolver, so authenticateMessage reaches
// trust_level 'verified' OFFLINE (no network, no opendkim). Keys are generated
// per call, so nothing secret is committed. NEVER imported from src/.

const crypto = require('node:crypto');
const { dkimSign } = require('mailauth');

const DEFAULT_HEADERS = ['from', 'to', 'subject', 'date', 'message-id'];

// RSA keypair → { privPem (pkcs8), pubB64 (spki/der, base64) } — the two shapes
// dkimSign (private) and the DKIM TXT record (public) need.
function makeDkimKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pubB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

// Prepend a relaxed/relaxed rsa-sha256 DKIM-Signature to rawEml.
async function signDkim(rawEml, { domain, selector, privateKeyPem, headers } = {}) {
  const input = Buffer.isBuffer(rawEml) ? rawEml : Buffer.from(String(rawEml));
  const headerList = (headers && headers.length ? headers : DEFAULT_HEADERS).join(':');
  const result = await dkimSign(input, {
    canonicalization: 'relaxed/relaxed',
    algorithm: 'rsa-sha256',
    signTime: new Date(),
    signatureData: [{ signingDomain: domain, selector, privateKey: privateKeyPem, headerList }],
  });
  if (result.errors && result.errors.length) {
    throw Object.assign(new Error('signDkim: mailauth reported signing errors'), { errors: result.errors });
  }
  return Buffer.concat([Buffer.from(result.signatures, 'utf8'), input]);
}

// Resolver compatible with mailauth's (name, type) => [[chunk, ...], ...] shape.
// Names absent from `map` raise ENOTFOUND, like a real missing record.
function buildResolver(map) {
  return async function resolver(name, type) {
    const rec = (type || 'TXT').toUpperCase() === 'TXT' ? map[name] : undefined;
    if (rec === undefined) {
      throw Object.assign(new Error(`stub-dns: no record for ${name}`), { code: 'ENOTFOUND' });
    }
    return [[rec]];
  };
}

// One call → a DKIM-signed .eml + the resolver that verifies it. From-domain is
// aligned with the DKIM signing domain and a p=none DMARC record is published,
// so classifyTrust(authenticate(...)) === 'verified'. `from` MUST be at `domain`.
async function verifiedFixture({
  domain = 'signer.example', selector = 'sel1',
  from, to, subject = 'Re: please sign', messageId, body = 'I confirm.\r\n',
} = {}) {
  if (!from || !from.endsWith('@' + domain)) {
    throw new Error(`verifiedFixture: from must be at @${domain} for DKIM alignment`);
  }
  const { privPem, pubB64 } = makeDkimKeypair();
  const unsigned = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId || `<${Date.now()}.${crypto.randomBytes(4).toString('hex')}@${domain}>`}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');
  const signedEml = await signDkim(unsigned, { domain, selector, privateKeyPem: privPem });
  const resolver = buildResolver({
    [`${selector}._domainkey.${domain}`]: `v=DKIM1; k=rsa; p=${pubB64}`,
    [`_dmarc.${domain}`]: 'v=DMARC1; p=none; adkim=r; aspf=r',
  });
  return { signedEml, resolver, domain, selector };
}

// A reusable verified signer for ONE domain: a single keypair + resolver, and a
// sign() that DKIM-signs any number of messages from that domain so several
// distinct senders (all @domain) authenticate to 'verified' under one resolver —
// what a multi-step workflow test needs (create() takes a single resolver).
function verifiedSigner({ domain = 'corp.example', selector = 'sel1' } = {}) {
  const { privPem, pubB64 } = makeDkimKeypair();
  const resolver = buildResolver({
    [`${selector}._domainkey.${domain}`]: `v=DKIM1; k=rsa; p=${pubB64}`,
    [`_dmarc.${domain}`]: 'v=DMARC1; p=none; adkim=r; aspf=r',
  });
  async function sign({ from, to, subject = 'Re: please confirm', body = 'I confirm.\r\n', messageId } = {}) {
    if (!from || !from.endsWith('@' + domain)) {
      throw new Error(`verifiedSigner.sign: from must be at @${domain} for DKIM alignment`);
    }
    const unsigned = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId || `<${Date.now()}.${crypto.randomBytes(4).toString('hex')}@${domain}>`}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');
    return signDkim(unsigned, { domain, selector, privateKeyPem: privPem });
  }
  return { resolver, sign, domain };
}

// A resolver where every lookup fails — nothing can authenticate (→ 'unverified').
const noDnsResolver = buildResolver({});

module.exports = {
  makeDkimKeypair, signDkim, buildResolver, verifiedFixture, verifiedSigner, noDnsResolver,
};
