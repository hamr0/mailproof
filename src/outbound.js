// Outbound send path — submit mail to the local MTA via sendmail(8).
//
// Why sendmail(8) rather than an SMTP client library:
//   - Postfix ships a drop-in sendmail binary that takes raw RFC-822 on
//     stdin and injects into the queue.
//   - opendkim is wired as a non_smtpd milter, so locally-submitted mail
//     gets signed automatically without any Node-side crypto.
//   - Zero external deps (stdlib child_process is enough).
//   - No SMTP AUTH / TLS / retry logic to maintain — Postfix owns that.
//
// Config is INJECTED, not read from the environment: the caller passes the
// sendmail `binary`, the `domain` (for Message-Id), and any `footer` text.
// There are no gitdone defaults — branding is the consumer's (PRD §8.6), so
// the footer is opt-in with no built-in text.
//
// The caller is responsible for building a valid RFC-822 message (CRLF line
// endings, headers separated from body by an empty line). buildRawMessage is
// the canonical builder.

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

function randomToken() {
  return crypto.randomBytes(8).toString('hex');
}

// Append an injected signature footer with a blank-line separator and the
// RFC 3676 §4.3 "-- " marker. No footer (falsy) → body is returned verbatim.
// Idempotent: a body that already ends with the signature isn't doubled.
/**
 * Append an injected signature footer (RFC 3676 `-- ` marker). Idempotent; a
 * falsy footer returns the body verbatim. Pure.
 * @param {string} body
 * @param {string | null | undefined} footer
 * @returns {string}
 */
function withSignature(body, footer) {
  if (!footer) return body;
  const sig = `-- \n${footer}`;
  if (body.endsWith(sig)) return body;
  return `${body}\n\n${sig}`;
}

// Generate an RFC 5322-conformant Message-Id of the form
// <timestamp.random@domain>. The 16-hex-char suffix (2^64) provides
// uniqueness within a single second on a single host. Domain is required —
// there is no fallback.
/**
 * Generate an RFC 5322 Message-Id `<timestamp.random@domain>`. Domain required.
 * @param {string} domain
 * @returns {string}
 */
function newMessageId(domain) {
  if (!domain) throw new Error('newMessageId: domain required');
  return `<${Date.now()}.${randomToken()}@${domain}>`;
}

// Format a UTC date as an RFC 5322 date-time string. Node's toUTCString()
// is already this format; wrapped for clarity and to make the dependency
// explicit.
/**
 * Format a date as an RFC 5322 date-time string. Pure.
 * @param {Date} [d]
 * @returns {string}
 */
function rfc5322Date(d = new Date()) {
  return d.toUTCString();
}

// Strip CR/LF so a user-supplied subject can't break out of the Subject
// header and inject extra ones. The boundary that emits the message is the
// last line of defence against header injection.
/**
 * Strip CR/LF from a subject so it can't inject extra headers. Pure.
 * @param {*} s
 * @returns {string}
 */
function sanitizeSubject(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ');
}

/**
 * Build a raw RFC-822 message from structured fields (plaintext only). The
 * canonical builder; from/to/subject/body are required.
 * @param {Object} fields
 * @param {string} fields.from
 * @param {string} fields.to
 * @param {string} fields.subject
 * @param {string} fields.body
 * @param {string} [fields.inReplyTo]
 * @param {string} [fields.references]
 * @param {string | false} [fields.autoSubmitted]
 * @param {string} [fields.messageId]
 * @param {Record<string, string>} [fields.extraHeaders]
 * @param {string} [fields.domain]
 * @param {string} [fields.replyTo]
 * @param {string} [fields.footer]
 * @returns {string}
 */
function buildRawMessage({ from, to, subject, body, inReplyTo, references, autoSubmitted, messageId, extraHeaders, domain, replyTo, footer }) {
  if (!from || !to || !subject || body == null) {
    throw new Error('buildRawMessage: from, to, subject, body are required');
  }
  subject = sanitizeSubject(subject);
  const signedBody = withSignature(body, footer)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n');
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${subject}`);
  lines.push(`Message-Id: ${messageId || newMessageId(domain || '')}`);
  lines.push(`Date: ${rfc5322Date()}`);
  if (autoSubmitted !== false) {
    // RFC 3834: auto-replied for a response to a specific human message;
    // auto-generated for pure notifications.
    lines.push(`Auto-Submitted: ${autoSubmitted || 'auto-replied'}`);
  }
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) {
      lines.push(`${name}: ${value}`);
    }
  }
  lines.push(''); // header/body separator
  lines.push(signedBody);
  // RFC-822 requires CRLF line endings.
  return lines.join('\r\n');
}

// Submit rawMessage to the local MTA. Returns { ok, code?, stderr?, reason? }.
// Never throws under normal operation — failure is reported via the resolved
// object so the caller can log + continue. `binary` is required (injected
// config); there is no environment fallback.
//
// Two addressing modes:
//   - default: sendmail -t reads recipients from To/Cc/Bcc headers
//   - positional: pass `to: [addr, ...]` to override the envelope and
//     ignore header recipients
/**
 * Submit a raw message to the local MTA via sendmail(8). Never throws under
 * normal operation — failure is reported in the resolved object. `binary` is
 * required (injected config).
 * @param {{ from?: string, rawMessage?: string, binary?: string | null, to?: string[] }} args
 * @returns {Promise<{ ok: boolean, code?: number, stderr?: string | null, reason?: string }>}
 */
function sendmail({ from, rawMessage, binary, to }) {
  if (!binary) {
    return Promise.resolve({ ok: false, reason: 'sendmail binary not configured' });
  }
  if (!rawMessage) {
    return Promise.resolve({ ok: false, reason: 'empty message' });
  }
  // -i: do NOT treat a line with a single "." as end-of-input (message
  //     bodies and forwarded emails may contain one)
  // -f: envelope MAIL FROM
  // If `to` given, pass positional recipients; otherwise use -t.
  const args = ['-i'];
  if (from) args.push('-f', from);
  if (to && to.length) {
    args.push('--', ...to);
  } else {
    args.push('-t');
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return resolve({ ok: false, reason: msg || String(err) });
    }
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => resolve({ ok: false, reason: err.message || String(err) }));
    // If the child exits before consuming stdin, writing raises EPIPE.
    // Swallow it — the exit-code handler is authoritative.
    child.stdin.on('error', () => {});
    child.on('exit', (code) => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, code: code == null ? undefined : code, stderr: stderr.trim() || null });
    });
    child.stdin.end(rawMessage);
  });
}

module.exports = { sendmail, buildRawMessage, sanitizeSubject, newMessageId, rfc5322Date, withSignature };
