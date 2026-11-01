// Relay evidence read from the header block: who sealed ARC, which list. Shared by
// the body-status hints and the record's `copy` classification (one definition).
// Domains only, never text.

import { parseTags } from './signed-headers.js';

/** @typedef {import('./signed-headers.js').HeaderRow} HeaderRow */

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
    const inner = (/<([^>]*)>/.exec(v)?.[1] ?? v).trim().toLowerCase();
    const dot = inner.indexOf('.');
    list_id_domain = (dot >= 0 ? inner.slice(dot + 1) : inner) || null;
  }
  return { arc_sealers, list_id_domain };
}

export { relayEvidence };
