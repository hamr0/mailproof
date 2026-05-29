// Humans-only pre-filter. Reject auto-responders, mailing lists, bulk mail,
// and system senders BEFORE any cryptographic verification — these never
// represent a participant confirming a step, and running DKIM on them wastes
// work and pollutes the ledger.
//
// Scans headers from the raw email buffer (regex over the raw byte block) so
// it does not depend on a structured MIME parse — header parsing of untrusted
// input is exactly where subtle bugs hide. Pure: no I/O, no config.


/**
 * Slice the leading header block out of raw message bytes (up to `maxBytes`),
 * stopping at the first blank line. Pure.
 * @param {Buffer} raw
 * @param {number} maxBytes
 * @returns {string}
 */
function extractHeaderBlock(raw, maxBytes) {
  const limit = Math.min(raw.length, maxBytes);
  const s = raw.slice(0, limit).toString('utf8');
  const endIdx = s.search(/\r?\n\r?\n/);
  return endIdx > 0 ? s.slice(0, endIdx) : s;
}

/**
 * Read a single unfolded header value from a header block (case-insensitive),
 * or null if absent. Pure.
 * @param {string} headerBlock
 * @param {string} name
 * @returns {string | null}
 */
function rawHeader(headerBlock, name) {
  const re = new RegExp('^' + name + '\\s*:\\s*(.+(?:\\r?\\n[ \\t].+)*)', 'im');
  const m = headerBlock.match(re);
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : null;
}

const SYSTEM_SENDER = /^(noreply|no-reply|mailer-daemon|postmaster|bounces)$/;
const BULK_PRECEDENCE = /^(bulk|list|junk)$/;

/**
 * Decide whether an inbound message should be rejected before any crypto/ledger
 * work — auto-responders, lists, bulk mail, system senders. Pure.
 * @param {string} headerBlock
 * @param {string | null} [fromAddr]
 * @returns {{ rejected: boolean, reason: string | null }}
 */
function preFilter(headerBlock, fromAddr) {
  const autoSubmitted = rawHeader(headerBlock, 'Auto-Submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') {
    return { rejected: true, reason: `auto-submitted: ${autoSubmitted}` };
  }

  if (rawHeader(headerBlock, 'List-Id')
      || rawHeader(headerBlock, 'List-Post')
      || rawHeader(headerBlock, 'List-Unsubscribe')) {
    return { rejected: true, reason: 'mailing list headers present' };
  }

  const prec = (rawHeader(headerBlock, 'Precedence') || '').toLowerCase();
  if (BULK_PRECEDENCE.test(prec)) {
    return { rejected: true, reason: `precedence: ${prec}` };
  }

  const addr = (fromAddr || '').toLowerCase();
  const local = addr.split('@')[0] || '';
  if (SYSTEM_SENDER.test(local)) {
    return { rejected: true, reason: `system sender: ${addr}` };
  }

  return { rejected: false, reason: null };
}

export { preFilter, extractHeaderBlock, rawHeader };
