// MANUAL live-DKIM harness — NOT part of `npm test` (excluded by the .mjs name;
// the CI glob is tests/**/*.test.js). Verifies a REAL message against LIVE DNS
// using mailproof's own public surface (authenticateMessage + classifyTrust).
//
// Two modes:
//
//   (A) Verify a raw .eml that was actually sent by the signing domain:
//         node tests/manual/verify-live.mjs tests/manual/inbox/incoming.eml
//       Looks up the signer's public key over real DNS (no injected resolver),
//       so a `verified` result is the true production path.
//
//   (B) Sign locally with a borrowed private key, then verify vs live DNS:
//         node tests/manual/verify-live.mjs --sign \
//           --domain signedreply.com --selector <sel> --key /path/to/sel.private \
//           --from you@signedreply.com
//
// Optional envelope for SPF (mode A): pass --sender / --ip / --helo if you have
// the original SMTP envelope. Without it, DKIM-aligned DMARC alone can still
// reach `verified` (DMARC passes on DKIM alignment).

import fs from 'node:fs';
import { dkimSign } from 'mailauth';
import { authenticateMessage, classifyTrust, summariseAuth, parseMessage } from '../../src/index.js';

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const wantSign = process.argv.includes('--sign');

async function buildSigned() {
  const domain = arg('domain');
  const selector = arg('selector');
  const keyPath = arg('key');
  const from = arg('from', `noreply@${domain}`);
  if (!domain || !selector || !keyPath) {
    throw new Error('--sign needs --domain, --selector, --key');
  }
  // `--key -` reads the PEM from stdin so a secret (e.g. piped from `pass`)
  // never touches disk and is never echoed.
  const privateKey = keyPath === '-' ? fs.readFileSync(0) : fs.readFileSync(keyPath);
  const unsigned = Buffer.from(
    [
      `From: ${from}`,
      `To: notarize+live@op.example`,
      `Subject: Re: live DKIM check`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <live.${Date.now()}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'I confirm. (live DKIM interop test)\r\n',
    ].join('\r\n')
  );
  const r = await dkimSign(unsigned, {
    canonicalization: 'relaxed/relaxed',
    algorithm: 'rsa-sha256',
    signTime: new Date(),
    signatureData: [
      {
        signingDomain: domain,
        selector,
        privateKey,
        headerList: 'from:to:subject:date:message-id',
      },
    ],
  });
  if (r.errors && r.errors.length) throw Object.assign(new Error('sign failed'), { errors: r.errors });
  return Buffer.concat([Buffer.from(r.signatures), unsigned]);
}

const raw = wantSign
  ? await buildSigned()
  : fs.readFileSync(arg('eml') || process.argv[2] || 'tests/manual/inbox/incoming.eml');

// LIVE DNS: no resolver injected → mailauth queries real DNS for the signer's key.
const envelope = {
  sender: arg('sender') || undefined,
  clientIp: arg('ip') || undefined,
  clientHelo: arg('helo') || undefined,
};

// Injected-DNS mode: when DKIM_PUB_RECORD is set (a public key record, e.g. the
// opendkim `.txt` format), verify against it instead of live DNS — used when the
// signing domain's selector isn't published. DMARC is synthesised (p=none) so
// classifyTrust can resolve alignment. Live DNS otherwise (resolver omitted).
let resolver;
const pubRecord = process.env.DKIM_PUB_RECORD;
if (pubRecord) {
  const record = [...pubRecord.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('').trim()
    || pubRecord.replace(/\s+/g, ' ').trim();
  const dom = arg('domain') || (raw.toString().match(/d=([^;\s]+)/) || [])[1];
  const sel = arg('selector') || (raw.toString().match(/\bs=([^;\s]+)/) || [])[1];
  const map = {
    [`${sel}._domainkey.${dom}`]: record,
    [`_dmarc.${dom}`]: 'v=DMARC1; p=none; adkim=s; aspf=s',
  };
  resolver = async (n, t) => {
    const r = (t || 'TXT').toUpperCase() === 'TXT' ? map[n] : undefined;
    if (r === undefined) throw Object.assign(new Error('no rec ' + n), { code: 'ENOTFOUND' });
    return [[r]];
  };
  console.log('(DNS: injected from DKIM_PUB_RECORD — not live)');
}

const auth = await authenticateMessage(raw, envelope, { resolver });
const summary = summariseAuth(auth);
const trust = classifyTrust(auth);

const sig = summary.dkim.signatures[0] || {};
console.log('── live DKIM verification (real DNS) ─────────────────────');
console.log('DKIM   :', sig.result, '| d=' + sig.domain, 's=' + sig.selector, sig.algorithm || '');
console.log('         ', sig.info || '');
console.log('SPF    :', summary.spf.result);
console.log('DMARC  :', summary.dmarc.result);
console.log('ARC    :', summary.arc.result);
console.log('TRUST  :', trust, trust === 'verified' ? '✓' : '');

// Show the notary capture half on a real message: hash any attachment exactly
// as ingest() would, so the same value verifyDocument() matches later.
const parsed = await parseMessage(raw);
console.log('── notary capture ───────────────────────────────────────');
console.log('From   :', parsed.from.address);
console.log('raw    :', parsed.rawSha256);
if (parsed.attachments.length) {
  for (const a of parsed.attachments) console.log('attach :', a.filename, a.sha256);
} else {
  console.log('attach : (none)');
}
