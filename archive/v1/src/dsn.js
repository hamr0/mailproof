// RFC 3464 Delivery Status Notification (DSN) parser — the inbound-bounce half
// of the trigger pillar (m7d-3). When an outbound notification fails permanently
// at a downstream MTA (mailbox gone, domain rejects us, …), that MTA posts a
// multipart/report message back to our envelope sender. mailproof signs outbound
// mail FROM the plus-tagged reply address (`event+{id}-{step}@` / `attest+{id}@`),
// so the bounce's return path — and thus its inbound envelope recipient — is the
// same plus-tag: ingest routes the bounce to the event/step by the address it
// already parses, and this module extracts WHY it failed.
//
// PURE + stdlib-only (no mailauth/mailparser): it parses raw bytes into a report
// shape and routes/persists nothing — ingest() wires the result into
// recordStepSendErrors + the `bounce` occasion. LIFTED from gitdone/app/src/dsn.js,
// re-anchored to operate on the RAW message (gitdone keyed off mailparser's
// `parsed.headers`, which mailproof's parseMessage intentionally doesn't expose;
// mailparser also folds message/delivery-status into `.text`, so raw bytes are
// the honest source either way).
//
// Wire format (RFC 3464 §2):
//   Content-Type: multipart/report; report-type=delivery-status; boundary=...
//   --boundary  / Content-Type: text/plain        → human summary (ignored)
//   --boundary  / Content-Type: message/delivery-status
//     Reporting-MTA: dns; mta.example.com
//     <blank>
//     Final-Recipient: rfc822;real@example.com
//     Action: failed
//     Status: 5.1.1
//     Diagnostic-Code: smtp; 550 5.1.1 user unknown
//   --boundary  / Content-Type: message/rfc822     → original echoed back
// We surface only the machine-readable per-recipient Status + Diagnostic-Code —
// the text/plain summary varies wildly between MTAs and isn't worth echoing.


// Split a raw message into its header block + body at the first blank line.
/**
 * @param {string} text
 * @returns {{ headerBlock: string, body: string }}
 */
function splitHeadersBody(text) {
  const s = String(text || '');
  const m = s.match(/\r?\n\r?\n/);
  if (!m || m.index == null) return { headerBlock: s, body: '' };
  return { headerBlock: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

// The top-level Content-Type value (RFC 5322 unfolded), or null.
/**
 * @param {string | null} headerBlock
 * @returns {string | null}
 */
function contentTypeOf(headerBlock) {
  if (!headerBlock) return null;
  const unfolded = String(headerBlock).replace(/\r?\n[ \t]+/g, ' ');
  const m = unfolded.match(/^content-type:[ \t]*(.+)$/im);
  return m ? m[1].trim() : null;
}

// Is this a delivery-status report? Takes the raw header block (what ingest
// already extracts). PURE.
/**
 * @typedef {Object} DsnRecipient
 * @property {string | null} originalRecipient
 * @property {string | null} finalRecipient
 * @property {string | null} action
 * @property {string | null} status
 * @property {string | null} diagnostic
 */
/**
 * @typedef {Object} Dsn
 * @property {Record<string, string>} reporting
 * @property {DsnRecipient[]} recipients
 * @property {string} [note]
 */

/**
 * Is this a multipart/report delivery-status message? Pure.
 * @param {string | null} headerBlock
 * @returns {boolean}
 */
function isDeliveryStatusReport(headerBlock) {
  const ct = contentTypeOf(headerBlock);
  if (!ct) return false;
  return /multipart\/report/i.test(ct) && /report-type\s*=\s*"?delivery-status"?/i.test(ct);
}

// Strip the "rfc822;" / "smtp;" address-type prefix (RFC 3464 §2.3.2).
/**
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function stripAddressType(value) {
  if (!value) return null;
  const m = String(value).match(/^[a-zA-Z0-9-]+\s*;\s*(.+)$/);
  return (m ? m[1] : String(value)).trim();
}

// Parse one "Field: value" group (folded continuations joined with a space).
/**
 * Parse one "Field: value" group (folded continuations joined). Pure.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseFieldGroup(text) {
  const lines = String(text || '').split(/\r?\n/);
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {string | null} */
  let curName = null;
  let curValue = '';
  const flush = () => {
    if (curName) fields[curName] = curValue.trim();
    curName = null;
    curValue = '';
  };
  for (const line of lines) {
    if (line === '') { flush(); continue; }
    if (/^[ \t]/.test(line) && curName) { curValue += ' ' + line.trim(); continue; }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    flush();
    curName = line.slice(0, idx).trim().toLowerCase();
    curValue = line.slice(idx + 1).trim();
  }
  flush();
  return fields;
}

// Parse a message/delivery-status body → { reporting, recipients[] }. The first
// blank-line-separated group is the per-message report (Reporting-MTA, …); each
// later group is a per-recipient block. Robust to MTA quirks (unknown fields
// ignored, missing blocks → []).
/**
 * Parse a message/delivery-status body into `{ reporting, recipients }`. Pure.
 * @param {string} text
 * @returns {Dsn}
 */
function parseDeliveryStatusBody(text) {
  const groups = String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((g) => g.trim())
    .filter(Boolean);
  if (groups.length === 0) return { reporting: /** @type {Record<string, string>} */ ({}), recipients: [] };
  const [first, ...rest] = groups;
  const reporting = parseFieldGroup(first);
  const recipients = rest.map((g) => {
    const f = parseFieldGroup(g);
    return {
      originalRecipient: stripAddressType(f['original-recipient']),
      finalRecipient: stripAddressType(f['final-recipient']),
      action: f['action'] ? f['action'].toLowerCase() : null,
      status: f['status'] || null,
      diagnostic: f['diagnostic-code'] || null,
    };
  });
  return { reporting, recipients };
}

// The boundary= parameter of a multipart Content-Type (RFC 2046; quoted or not).
/**
 * @param {string | null} contentTypeHeader
 * @returns {string | null}
 */
function extractBoundary(contentTypeHeader) {
  if (!contentTypeHeader) return null;
  const m = String(contentTypeHeader).match(/boundary\s*=\s*("([^"]+)"|([^;\s]+))/i);
  if (!m) return null;
  return m[2] || m[3] || null;
}

// Split a raw multipart body into each part's raw text (headers + blank + body).
// Preamble/epilogue and the closing "--boundary--" are discarded.
/**
 * @param {Buffer | string | null} rawBody
 * @param {string | null} boundary
 * @returns {string[]}
 */
function splitMultipart(rawBody, boundary) {
  if (!rawBody || !boundary) return [];
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const marker = `--${boundary}`;
  /** @type {string[]} */
  const parts = [];
  let i = text.indexOf(marker);
  while (i !== -1) {
    const after = i + marker.length;
    if (text.slice(after, after + 2) === '--') break; // closing boundary
    const nl = text.indexOf('\n', after);
    if (nl === -1) break;
    const partStart = nl + 1;
    const next = text.indexOf(marker, partStart);
    if (next === -1) break;
    let partEnd = next;
    if (text[partEnd - 1] === '\n') partEnd -= 1;
    if (text[partEnd - 1] === '\r') partEnd -= 1;
    parts.push(text.slice(partStart, partEnd));
    i = next;
  }
  return parts;
}

// Split a MIME part into { headers, body } on the first blank line.
/**
 * @param {string | null} part
 * @returns {{ headers: string, body: string }}
 */
function splitPart(part) {
  const m = String(part || '').match(/^([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (!m) return { headers: part || '', body: '' };
  return { headers: m[1], body: m[2] };
}

// Top-level: parse a raw DSN message → { reporting, recipients } | null (not a
// DSN). PURE; no network, no fs.
/**
 * Parse a raw DSN message into `{ reporting, recipients }`, or null if it is not
 * a delivery-status report. Pure; no network, no fs.
 * @param {Buffer | string} raw
 * @returns {Dsn | null}
 */
function extractDsn(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const { headerBlock, body } = splitHeadersBody(text);
  if (!isDeliveryStatusReport(headerBlock)) return null;
  const boundary = extractBoundary(contentTypeOf(headerBlock));
  if (!boundary) return { reporting: {}, recipients: [], note: 'no boundary' };
  const dsPart = splitMultipart(body, boundary)
    .map(splitPart)
    .find((p) => /content-type\s*:\s*message\/delivery-status/i.test(p.headers));
  if (!dsPart) return { reporting: {}, recipients: [], note: 'no delivery-status part found' };
  return parseDeliveryStatusBody(dsPart.body);
}

// The recipient blocks that represent a PERMANENT failure (Action: failed, or a
// 5.x status when Action is absent) — the ones worth alerting the initiator on.
// Transient "delayed" (4.x) reports are not surfaced.
/**
 * The recipient blocks representing a PERMANENT failure (worth alerting on).
 * Pure.
 * @param {Dsn | null} dsn
 * @returns {DsnRecipient[]}
 */
function permanentFailures(dsn) {
  const recipients = (dsn && dsn.recipients) || [];
  return recipients.filter((r) => r.action === 'failed' || (!r.action && r.status && /^5\./.test(r.status)));
}

export {
  isDeliveryStatusReport,
  extractDsn,
  permanentFailures,
  parseDeliveryStatusBody,
  parseFieldGroup,
  stripAddressType,
  contentTypeOf,
};
