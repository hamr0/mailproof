// TEST-ONLY. Hand-built reply bodies in the styles of the mail clients M2 was proven on (findings F20). No real mail:
// every name, address and sentence here is invented. NEVER imported from src/.
//
// Each fixture: { name, raw, expect: { text, quote, trailing, boundary, source } } for the stripper `mailproof-quote/1`.

const NL = '\r\n';
const lines = (...l) => l.join(NL);
/** A single-part message with the given content type, optional transfer encoding and body (a string of Latin-1 chars). */
const part = (ct, body, cte) => Buffer.from(lines(`Content-Type: ${ct}`, ...(cte ? [`Content-Transfer-Encoding: ${cte}`] : []), '', body), 'latin1');

const QUOTED = 'Approve payment of $5,000?';   // the trap: a reply that quotes this is not an approval

/** @type {Array<{ name: string, raw: Buffer, expect: { text: string, quote: string, trailing: boolean, boundary: string | null, source: string } }>} */
export const FIXTURES = [
  {
    name: 'Thunderbird attribution, format=flowed (a flowed line joined)',
    raw: part('text/plain; charset=UTF-8; format=flowed', lines(
      'Yes, approved. Please go ahead with the payment as soon as the long ',
      'line you sent is confirmed.',
      '',
      'On 11/3/25 10:00, Bob Example wrote:',
      `> ${QUOTED} `,
      '> Thanks'), '8bit'),
    expect: { text: 'Yes, approved. Please go ahead with the payment as soon as the long line you sent is confirmed.', quote: 'found', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'Outlook -----Original Message-----',
    raw: part('text/plain; charset=utf-8', lines('Approved.', '', '-----Original Message-----', 'From: Bob Example <bob@example.net>', 'Sent: Monday, November 3, 2025 10:00 AM', 'To: Alice', `Subject: ${QUOTED}`, '', QUOTED)),
    expect: { text: 'Approved.', quote: 'found', trailing: false, boundary: 'outlook-original', source: 'text/plain' },
  },
  {
    name: 'Outlook From/Sent header block under a rule line',
    raw: part('text/plain; charset=utf-8', lines('Approved.', '', '________________________________', 'From: Bob Example <bob@example.net>', 'Sent: Monday, November 3, 2025 10:00 AM', 'To: Alice', `Subject: ${QUOTED}`, '', QUOTED)),
    expect: { text: 'Approved.', quote: 'found', trailing: false, boundary: 'outlook-header', source: 'text/plain' },
  },
  {
    name: 'Outlook Dutch Van:/Verzonden: header block',
    raw: part('text/plain; charset=utf-8', lines('Akkoord, graag uitvoeren.', '', 'Van: Bob Voorbeeld <bob@example.net>', 'Verzonden: maandag 3 november 2025 10:00', 'Aan: Alice', 'Onderwerp: Betaling', '', 'Keur de betaling goed?')),
    expect: { text: 'Akkoord, graag uitvoeren.', quote: 'found', trailing: false, boundary: 'outlook-header', source: 'text/plain' },
  },
  {
    name: 'Gmail attribution wrapped over two lines',
    raw: part('text/plain; charset="UTF-8"', lines('Yes please.', '', 'On Mon, Nov 3, 2025 at 10:00 AM Bob Example', '<bob@example.net> wrote:', '', `> ${QUOTED}`)),
    expect: { text: 'Yes please.', quote: 'found', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'Foxmail-style From/Date block',
    raw: part('text/plain; charset=utf-8', lines('Done, thanks.', '', 'From: "Bob Example" <bob@example.net>', 'Date: Mon, Nov 3, 2025 10:00 AM', 'To: "Alice" <alice@example.org>', 'Subject: Re: payment', '', QUOTED)),
    expect: { text: 'Done, thanks.', quote: 'found', trailing: false, boundary: 'outlook-header', source: 'text/plain' },
  },
  {
    name: 'forward marker',
    raw: part('text/plain; charset=utf-8', lines('FYI, see below.', '', '---------- Forwarded message ---------', 'From: Bob Example <bob@example.net>', 'Date: Mon, Nov 3, 2025', '', QUOTED)),
    expect: { text: 'FYI, see below.', quote: 'found', trailing: false, boundary: 'forward-marker', source: 'text/plain' },
  },
  {
    name: 'a > run with no attribution',
    raw: part('text/plain; charset=utf-8', lines('Agreed.', '> ' + QUOTED, '> ok?')),
    expect: { text: 'Agreed.', quote: 'found', trailing: false, boundary: 'quote-run', source: 'text/plain' },
  },
  {
    name: 'no quote: the whole body is returned (not-found)',
    raw: part('text/plain; charset=utf-8', lines('Just a plain note.', 'Second line.', '')),
    expect: { text: 'Just a plain note.\nSecond line.', quote: 'not-found', trailing: false, boundary: null, source: 'text/plain' },
  },
  {
    name: 'inline answers inside the quote (not merged)',
    raw: part('text/plain; charset=utf-8', lines('Hi, answers inline.', '', 'On Mon, Bob Example wrote:', '> Question one?', 'Answer one.', '> Question two?', 'Answer two.')),
    expect: { text: 'Hi, answers inline.', quote: 'inline', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'signature below the quote (trailing)',
    raw: part('text/plain; charset=utf-8', lines('Yes.', '', 'On Mon, Bob Example wrote:', `> ${QUOTED}`, '', '-- ', 'Alice Example', 'Example Corp')),
    expect: { text: 'Yes.', quote: 'found', trailing: true, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'bottom-posted text below the quote (trailing)',
    raw: part('text/plain; charset=utf-8', lines('On Mon, Bob Example wrote:', `> ${QUOTED}`, '', 'Yes, approved.')),
    expect: { text: '', quote: 'found', trailing: true, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'html-only message',
    raw: part('text/html; charset=utf-8', `<p>${QUOTED}</p>`),
    expect: { text: '', quote: 'not-found', trailing: false, boundary: null, source: 'html-only' },
  },
  {
    name: 'multipart/alternative: the text/plain part is used',
    raw: Buffer.from(lines('Content-Type: multipart/alternative; boundary="alt1"', '', 'preamble', '--alt1', 'Content-Type: text/html; charset=utf-8', '', '<p>Approved.</p>', '--alt1', 'Content-Type: text/plain; charset=utf-8', '', 'Approved.', '', 'On Mon, Bob Example wrote:', `> ${QUOTED}`, '--alt1--', ''), 'latin1'),
    expect: { text: 'Approved.', quote: 'found', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'quoted-printable, utf-8 (soft break, =3D, trailing blank dropped)',
    raw: part('text/plain; charset=utf-8', lines('Caf=C3=A9 is fine=2C a=3Db and a soft=', ' break.   ', '', 'On Mon, Bob Example wrote:', `> ${QUOTED}`), 'quoted-printable'),
    expect: { text: 'Café is fine, a=b and a soft break.', quote: 'found', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'base64, utf-8',
    raw: part('text/plain; charset=utf-8', Buffer.from(lines('Ça va, d’accord.', '', 'On Mon, Bob Example wrote:', `> ${QUOTED}`), 'utf8').toString('base64').replace(/(.{40})/g, '$1' + NL), 'base64'),
    expect: { text: 'Ça va, d’accord.', quote: 'found', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'windows-1252 via quoted-printable (euro sign, curly quotes)',
    raw: part('text/plain; charset=windows-1252', lines('Total =80 5=93,000=94 approved.', '', 'On Mon, Bob Example wrote:', `> ${QUOTED}`), 'quoted-printable'),
    expect: { text: 'Total € 5“,000” approved.', quote: 'found', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
  {
    name: 'us-ascii, 7bit',
    raw: part('text/plain; charset=us-ascii', lines('Plain ascii answer.', '', 'On Mon, Bob Example wrote:', `> ${QUOTED}`)),
    expect: { text: 'Plain ascii answer.', quote: 'found', trailing: false, boundary: 'attribution', source: 'text/plain' },
  },
];

export { QUOTED };
