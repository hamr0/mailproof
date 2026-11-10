// Validators for command-line values (SPEC B11.1, B11.5). The subcommands and the menu prompts use the same ones, so a
// value is accepted or refused the same way wherever it is typed. Each throws UsageError naming the flag.

import fs from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from './errors.js';
import { recordPath } from '../proof/layout.js';

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;
const FULL_ID_RE = /^[0-9a-f]{32}$/;
const PREFIX_RE = /^[0-9a-f]{8,31}$/;
const DURATION_RE = /^(\d+)(s|m|h)$/;

export const MIN_INTERVAL_MS = 30_000;

/**
 * `YYYY-MM-DD` (UTC midnight) or a full ISO-8601 time with a zone.
 * @param {string} s
 * @param {string} flag
 * @returns {Date}
 */
export function parseDate(s, flag) {
  const t = s.trim();
  const m = DATE_ONLY_RE.exec(t);
  if (m) {
    const d = new Date(`${t}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t) return d;
  } else if (ISO_RE.test(t)) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new UsageError(`${flag}: "${s}" is not a date; use YYYY-MM-DD (UTC) or a full time like 2026-08-19T10:00:00Z`);
}

/**
 * @param {string} s
 * @param {string} flag
 * @returns {string}
 */
export function parseAddress(s, flag) {
  const t = s.trim();
  if (!ADDRESS_RE.test(t)) throw new UsageError(`${flag}: "${s}" is not an email address (one exact address, like bob@example.org)`);
  return t;
}

/**
 * `30s`, `5m`, `1h`.
 * @param {string} s
 * @param {string} flag
 * @param {number} [minMs]
 * @returns {number}  Milliseconds.
 */
export function parseDuration(s, flag, minMs = MIN_INTERVAL_MS) {
  const m = DURATION_RE.exec(s.trim());
  if (!m) throw new UsageError(`${flag}: "${s}" is not a duration; use 30s, 5m or 1h`);
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[/** @type {'s' | 'm' | 'h'} */ (m[2])];
  if (ms < minMs) throw new UsageError(`${flag}: the minimum is ${minMs / 1000}s`);
  return ms;
}

/**
 * @param {string} s
 * @param {string} flag
 * @returns {number}  A non-negative integer.
 */
export function parseLimit(s, flag) {
  if (!/^\d+$/.test(s.trim())) throw new UsageError(`${flag}: "${s}" is not a whole number`);
  return Number(s);
}

/**
 * `on`, `off`, or a folder path.
 * @param {string} s
 * @returns {boolean | string}
 */
export function parseSent(s) {
  const t = s.trim();
  if (!t) throw new UsageError('--sent: give on, off or a folder path');
  const l = t.toLowerCase();
  return l === 'on' ? true : l === 'off' ? false : t;
}

/**
 * @param {string} s
 * @returns {string[]}
 */
export function parseFolders(s) {
  const f = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (!f.length) throw new UsageError('--folders needs at least one folder');
  return f;
}

/**
 * @param {string} s
 * @param {string} flag
 * @returns {string}
 */
export function parseChoice(s, flag, /** @type {string[]} */ ...allowed) {
  const t = s.trim().toLowerCase();
  if (!allowed.includes(t)) throw new UsageError(`${flag}: use ${allowed.join(', ')}`);
  return t;
}

/**
 * A record id (32 hex) or a unique prefix of at least 8 hex. A prefix is looked up in the shard directory of the trail
 * (the first two hex characters of an id name it), so it needs neither git nor the index.
 * @param {string} s
 * @param {string} trailRoot  The trail's working tree.
 * @returns {Promise<string>}  The full id.
 */
export async function resolveId(s, trailRoot) {
  const t = s.trim().toLowerCase();
  if (FULL_ID_RE.test(t)) return t;
  if (!PREFIX_RE.test(t)) throw new UsageError(`"${s}" is not a record id: give 32 hex characters, or a unique prefix of at least 8`);
  const dir = path.join(trailRoot, path.dirname(recordPath(t.padEnd(32, '0'))));
  /** @type {string[]} */
  let names = [];
  try { names = await fs.readdir(dir); } catch { /* no such shard */ }
  const hits = names.filter((n) => n.endsWith('.json') && n.startsWith(t)).map((n) => n.slice(0, -5));
  if (hits.length === 0) throw new UsageError(`no record has an id starting with ${t}`);
  if (hits.length > 1) throw new UsageError(`${t} is ambiguous: ${hits.slice(0, 10).join(', ')}${hits.length > 10 ? ', ...' : ''}`);
  return hits[0];
}

/** @param {string} s @returns {string} The Message-ID with angle brackets. */
export function messageIdOf(s) {
  const t = s.trim();
  if (!t) throw new UsageError('a Message-ID is required');
  return t.startsWith('<') ? t : `<${t}>`;
}

export { FULL_ID_RE };
