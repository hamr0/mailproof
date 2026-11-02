// Relay evidence read from the header block: who sealed ARC, which list. Shared by
// the body-status hints and the record's `copy` classification (one definition).
// Domains only, never text.

import { parseTags } from './signed-headers.js';

/** @typedef {import('./signed-headers.js').HeaderRow} HeaderRow */

/**
 * The text between the first `<` and the first `>` after it, or `v` when there
 * is no such pair. Two `indexOf`s: the equivalent regex (`<([^>]*)>`) rescans to
 * the end of the value from every `<` when no `>` follows.
 * @param {string} v
 * @returns {string}
 */
function listIdInner(v) {
  const open = v.indexOf('<');
  const close = open === -1 ? -1 : v.indexOf('>', open + 1);
  return close === -1 ? v : v.slice(open + 1, close);
}

/**
 * ARC sealer domains (the `d=` of every ARC-Seal, lower-cased, deduped, in order)
 * and the List-Id domain (the List-Id minus its first label, the list name).
 * @param {HeaderRow[]} rows
 * @returns {{ arc_sealers: string[], list_id_domain: string | null }}
 */
function relayEvidence(rows) {
  const arc_sealers = [...new Set(rows.filter((r) => r.name === 'arc-seal').map((r) => (parseTags(r.raw).d || '').toLowerCase()).filter(Boolean))];
  const lid = rows.find((r) => r.name === 'list-id');
  let list_id_domain = null;
  if (lid) {
    const v = lid.raw.slice(lid.raw.indexOf(':') + 1).trim();
    const inner = listIdInner(v).trim().toLowerCase();
    const dot = inner.indexOf('.');
    list_id_domain = (dot >= 0 ? inner.slice(dot + 1) : inner) || null;
  }
  return { arc_sealers, list_id_domain };
}

export { relayEvidence, listIdInner };
