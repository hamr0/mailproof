
// Unit tests for the PURE RFC 3464 DSN parser. No fs, no process, no mailparser
// — raw bytes in, a report shape out. The ingest() bounce wiring (route by
// plus-tag, record the step error, emit the `bounce` occasion) is covered in
// tests/integration/ingest-bounce.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDeliveryStatusReport, extractDsn, permanentFailures, parseDeliveryStatusBody,
  stripAddressType, contentTypeOf,
} from '../../src/dsn.js';

const CRLF = '\r\n';
function dsn({ boundary = 'BOUND', action = 'failed', status = '5.1.1', diagnostic = 'smtp; 550 5.1.1 user unknown', finalRecipient = 'alice@corp.example' } = {}) {
  return [
    'From: MAILER-DAEMON@mx.example',
    'To: event+wfX-s1@app.example',
    'Subject: Undelivered Mail Returned to Sender',
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain',
    '',
    'Delivery to the following recipient failed permanently.',
    '',
    `--${boundary}`,
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.example',
    'Arrival-Date: Tue, 27 May 2026 10:00:00 +0000',
    '',
    `Final-Recipient: rfc822;${finalRecipient}`,
    `Action: ${action}`,
    `Status: ${status}`,
    `Diagnostic-Code: ${diagnostic}`,
    '',
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    'From: event+wfX-s1@app.example',
    'To: alice@corp.example',
    'Subject: Action needed',
    '',
    `--${boundary}--`,
    '',
  ].join(CRLF);
}

test('isDeliveryStatusReport: true for a multipart/report delivery-status header block', () => {
  const headerBlock = 'Content-Type: multipart/report; report-type=delivery-status; boundary="x"';
  assert.equal(isDeliveryStatusReport(headerBlock), true);
});

test('isDeliveryStatusReport: false for ordinary mail and folded non-DSN reports', () => {
  assert.equal(isDeliveryStatusReport('Content-Type: text/plain'), false);
  assert.equal(isDeliveryStatusReport('Content-Type: multipart/report; report-type=disposition-notification'), false);
  assert.equal(isDeliveryStatusReport(''), false);
});

test('isDeliveryStatusReport: handles a folded Content-Type header', () => {
  const folded = 'Content-Type: multipart/report;\r\n report-type=delivery-status;\r\n boundary="x"';
  assert.equal(isDeliveryStatusReport(folded), true);
});

test('extractDsn: parses the failed recipient, status and diagnostic', () => {
  const out = extractDsn(dsn());
  assert.equal(out.reporting['reporting-mta'], 'dns; mx.example');
  assert.equal(out.recipients.length, 1);
  assert.deepEqual(out.recipients[0], {
    originalRecipient: null,
    finalRecipient: 'alice@corp.example',
    action: 'failed',
    status: '5.1.1',
    diagnostic: 'smtp; 550 5.1.1 user unknown',
  });
});

test('extractDsn: returns null for a non-DSN message', () => {
  const plain = 'From: a@b.example\r\nContent-Type: text/plain\r\n\r\nhello';
  assert.equal(extractDsn(plain), null);
});

test('permanentFailures: keeps 5.x / Action:failed, drops transient Action:delayed', () => {
  const failed = extractDsn(dsn({ action: 'failed', status: '5.1.1' }));
  assert.equal(permanentFailures(failed).length, 1);

  const delayed = extractDsn(dsn({ action: 'delayed', status: '4.4.1' }));
  assert.equal(permanentFailures(delayed).length, 0);
});

test('permanentFailures: falls back to a 5.x status when Action is absent', () => {
  const report = { recipients: [{ action: null, status: '5.7.1', finalRecipient: 'x@y.example' }] };
  assert.equal(permanentFailures(report).length, 1);
});

test('stripAddressType: removes the rfc822;/smtp; prefix', () => {
  assert.equal(stripAddressType('rfc822;alice@corp.example'), 'alice@corp.example');
  assert.equal(stripAddressType('rfc822; bob@x.example'), 'bob@x.example');
  assert.equal(stripAddressType('plain@nope.example'), 'plain@nope.example');
  assert.equal(stripAddressType(null), null);
});

test('contentTypeOf: unfolds and returns the first Content-Type value', () => {
  assert.equal(contentTypeOf('Subject: x\r\nContent-Type: text/plain; charset=utf-8'), 'text/plain; charset=utf-8');
});

test('parseDeliveryStatusBody: tolerates multiple recipient blocks', () => {
  const body = [
    'Reporting-MTA: dns; mx.example',
    '',
    'Final-Recipient: rfc822;a@x.example',
    'Action: failed',
    'Status: 5.1.1',
    '',
    'Final-Recipient: rfc822;b@x.example',
    'Action: failed',
    'Status: 5.2.2',
  ].join('\n');
  const out = parseDeliveryStatusBody(body);
  assert.equal(out.recipients.length, 2);
  assert.equal(out.recipients[1].finalRecipient, 'b@x.example');
  assert.equal(out.recipients[1].status, '5.2.2');
});
