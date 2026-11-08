// M2 POC harness. Usage: node poc/m2-quotes/run.mjs [dir ...]   (env M2_REVIEW = review folder, default ~/mailproof-m2-review)
// Console output is aggregate only (ids, counts, flags). Extracted text and the id -> file map go ONLY to the review
// folder, outside the repo. Needs no network except the DNS lookups check() makes for DKIM keys.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMessage, strip, classify, isReplyOrForward, isDigestish, rfc822Parts, findTextPart } from './strip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { Mailproof } = await import(path.join(root, 'src/index.js'));
const { makeTmpDir } = await import(path.join(root, 'tests/helpers/tmp.js'));

const home = os.homedir();
const dirs = process.argv.length > 2 ? process.argv.slice(2) : [
  ...fs.readdirSync(home).filter((n) => n.startsWith('mailproof-m0-samples')).map((n) => path.join(home, n)),
  path.join(home, 'PycharmProjects/gitdone/poc/phase0'), path.join(home, 'mail-samples/m2-replies'),
].filter((d) => fs.existsSync(d));
const review = process.env.M2_REVIEW || path.join(home, 'mailproof-m2-review');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.eml$/i.test(e.name) ? [path.join(d, e.name)] : []);
}
const files = [...new Set(dirs.flatMap(walk))].sort();

// ---- collect samples ----
const samples = []; const stat = { files: files.length, notReply: 0, digestsExpanded: 0, digestParts: 0, digestPlainSkipped: 0 };
const nonReplies = [];
for (const f of files) {
  const raw = fs.readFileSync(f);
  const msg = parseMessage(raw);
  if (isDigestish(msg)) {
    const parts = rfc822Parts(msg);
    if (parts.length) {
      stat.digestsExpanded++; stat.digestParts += parts.length;
      parts.forEach((p, i) => { if (isReplyOrForward(parseMessage(p))) samples.push({ file: f, part: i + 1, raw: p, digest: true }); });
      continue;
    }
    stat.digestPlainSkipped++; continue;
  }
  if (isReplyOrForward(msg)) samples.push({ file: f, part: null, raw, digest: false }); else { stat.notReply++; nonReplies.push(raw); }
}

fs.mkdirSync(review, { recursive: true, mode: 0o700 }); fs.chmodSync(review, 0o700);
const tmp = makeTmpDir('m2-quotes-');
const mp = new Mailproof({ trailDir: tmp, worker: { size: 0 } });

const pad = (n) => 'S' + String(n).padStart(2, '0');
const rows = [];
for (const [i, s] of samples.entries()) {
  const id = pad(i + 1);
  const msg = parseMessage(s.raw);
  const r1 = strip(s.raw), r2 = strip(s.raw);
  const ctl = strip(s.raw, { detectors: false });
  let body_status = 'error';
  try { body_status = (await mp.check(s.raw)).body_status; } catch (e) { body_status = 'error:' + (e.code || e.name); }
  rows.push({ id, s, client: classify(msg), r: r1, deterministic: r1.text_sha256 === r2.text_sha256 && r1.quote === r2.quote && r1.boundary === r2.boundary, ctl, body_status });
  const content = r1.source === 'html-only' ? '(no text/plain part: html-only, nothing extracted)\n' : r1.text + '\n=====8<===== FULL NORMALIZED PLAIN BODY (for comparison) =====8<=====\n' + r1.body + '\n';
  fs.writeFileSync(path.join(review, id + '.txt'), content, { mode: 0o600 });
}

// ---- review index ----
const intro = `# M2 quote-stripper review (stripper mailproof-quote/1)

Private: real mail text lives in this folder. Never copy it into the repo.

How to review. For each row open \`Sxx.txt\`. The part ABOVE the line \`=====8<===== FULL NORMALIZED PLAIN BODY\` is what the stripper returned as "new text"; the part below is the whole plain body for comparison. Ask: does the top block contain exactly what the sender newly wrote, nothing quoted and nothing missing? Put \`y\` or \`n\` in \`correct?\` and a short reason in \`note\` (for example: quoted text leaked in, new text cut off, text written below the quote was lost, wrong client, inline answers). Rows with source \`html-only\` have no extraction to judge. Signatures are deliberately NOT stripped, so a signature in the top block is correct.

Columns: quote = found | not-found | inline; boundary = which rule fired; body_status = would the text count as proven (matched / partial) or not; text_bytes = UTF-8 bytes of the extracted text.

`;
let md = intro + '| id | file | client | source | quote | boundary | body_status | text_bytes | correct? (y/n) | note |\n|---|---|---|---|---|---|---|---|---|---|\n';
for (const x of rows) md += `| ${x.id} | ${x.s.file}${x.s.part ? ' (digest part ' + x.s.part + ')' : ''} | ${x.client} | ${x.r.source} | ${x.r.quote ?? '-'} | ${x.r.boundary ?? '-'} | ${x.body_status} | ${x.r.text_bytes ?? '-'} |  |  |\n`;
fs.writeFileSync(path.join(review, 'INDEX.md'), md, { mode: 0o600 });

// ---- aggregates (no sample content) ----
const tally = (keyf, list = rows) => { const m = new Map(); for (const x of list) { const k = keyf(x); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort(); };
const show = (title, entries) => { console.log('\n' + title); for (const [k, v] of entries) console.log(`  ${String(k).padEnd(48)} ${v}`); };
console.log('stripper mailproof-quote/1; review folder written (' + rows.length + ' samples)');
console.log('input:', JSON.stringify(stat), 'replies/forwards sampled:', rows.length);
show('client', tally((x) => x.client));
show('source', tally((x) => x.r.source));
show('client x source x quote', tally((x) => `${x.client} | ${x.r.source} | ${x.r.quote ?? '-'}`));
show('quote x boundary', tally((x) => `${x.r.quote ?? '-'} | ${x.r.boundary ?? '-'}`));
show('body_status', tally((x) => x.body_status));
show('client x body_status', tally((x) => `${x.client} | ${x.body_status}`));
show('quote x body_status (proven = matched|partial)', tally((x) => `${x.r.quote ?? '-'} | ${['matched', 'partial'].includes(x.body_status) ? 'proven' : 'unproven'}`));
const txt = rows.filter((x) => x.r.source === 'text/plain');
show('charsets (text/plain)', tally((x) => x.r.charset, txt));
show('transfer encodings', tally((x) => x.r.cte, txt));
console.log('\nformat=flowed seen:', txt.filter((x) => x.r.flowed).length, ' unsupported charset:', txt.filter((x) => x.r.unsupported_charset).length);
console.log('html-only:', rows.filter((x) => x.r.source === 'html-only').length, '/', rows.length);
console.log('determinism (two runs identical):', rows.every((x) => x.deterministic) ? 'all ' + rows.length + ' identical' : 'MISMATCH ' + rows.filter((x) => !x.deterministic).map((x) => x.id));

// ---- can it fail? ----
const clearly = txt.filter((x) => x.r.gt_lines > 0 || /original message/i.test(x.r.body));
const changed = txt.filter((x) => x.ctl.text_sha256 !== x.r.text_sha256);
console.log('\nCONTROL (detectors off): every control result is not-found:', txt.every((x) => x.ctl.quote === 'not-found'));
console.log(`  samples whose text changes when detectors are off: ${changed.length} of ${txt.length}`);
console.log(`  samples that clearly quote (>=1 '>' line or "original message"): ${clearly.length}; of those, changed: ${clearly.filter((x) => changed.includes(x)).length}; not-found with detectors ON: ${clearly.filter((x) => x.r.quote === 'not-found').length}`);
console.log(`  not-found with detectors ON but no '>' lines: ${txt.filter((x) => x.r.quote === 'not-found' && x.r.gt_lines === 0).length}; found/inline: ${txt.filter((x) => x.r.quote !== 'not-found').length}`);
const idem = txt.filter((x) => { const y = strip(Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\n' + x.r.text)); return y.text_sha256 === x.r.text_sha256 && y.quote === 'not-found'; });
console.log(`  idempotence (re-strip of extracted text is unchanged and not-found): ${idem.length} of ${txt.length}`);
const degenerate = {
  empty_text: txt.filter((x) => x.r.text_bytes === 0).length,
  text_is_whole_body: txt.filter((x) => x.r.quote !== 'not-found' && x.r.text === x.r.body.replace(/\s+$/, '')).length,
  text_under_20_bytes: txt.filter((x) => x.r.text_bytes > 0 && x.r.text_bytes < 20).length,
  text_after_last_quote_line_dropped: txt.filter((x) => x.r.quote !== 'not-found' && x.r.after_quote_lines > 0).length,
};
console.log(`trailing (unquoted text after the quote, dropped, flagged): ${txt.filter((x) => x.r.trailing).length} of ${txt.length}`);
console.log('degenerate checks:', JSON.stringify(degenerate));
// negative population: mail that is not a reply should seldom produce a boundary
let nf = 0, nfound = 0, nBoundary = new Map();
for (const raw of nonReplies) { const y = strip(raw); if (y.source === 'html-only') continue; nf++; if (y.quote !== 'not-found') { nfound++; nBoundary.set(y.boundary, (nBoundary.get(y.boundary) || 0) + 1); } }
console.log(`non-reply population (not a sample): ${nf} with text/plain, ${nfound} got a boundary`, JSON.stringify([...nBoundary]));
fs.rmSync(tmp, { recursive: true, force: true });
await mp.close?.();
