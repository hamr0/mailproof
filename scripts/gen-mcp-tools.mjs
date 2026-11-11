#!/usr/bin/env node
// Generate src/mcp/tools.generated.js (SPEC B12.4): the MCP tool list, built from the hand-written table in
// src/mcp/tools.js and the library's own JSDoc text (primitives.json `when`/`fails`, or a shorter `@mcp` text).
// The hash-pinned primitives generator cannot carry a new tag (it fails on an unknown tag in a @when block), so an `@mcp`
// text is its own one-line block beside the method: `/** @mcp Mailproof#forget <text> */`, read here from src/proof/*.js.
// `--check` regenerates in memory and fails when the committed file is stale (CI), like check:primitives.
import fs from 'node:fs';
import { TOOLS, EXCLUDED, SERVER_ARGS } from '../src/mcp/tools.js';

const root = new URL('../', import.meta.url);
const OUT = new URL('src/mcp/tools.generated.js', root);
export const MCP_MAX_CHARS = 700;

const primitives = () => JSON.parse(fs.readFileSync(new URL('primitives.json', root), 'utf8')).primitives;

/** @returns {Map<string, string>} `@mcp` texts by primitive name, from every file under src/proof. */
export function mcpTexts() {
  const out = new Map();
  const dir = new URL('src/proof/', root);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/\/\*\* @mcp (\S+) ([\s\S]*?) \*\//g)) {
      if (out.has(m[1])) throw new Error(`gen-mcp-tools: two @mcp texts for ${m[1]}`);
      out.set(m[1], m[2].trim());
    }
  }
  return out;
}

/** @param {string} name @returns {string} The primitives.json name of a tool. */
const primitiveOf = (name) => (TOOLS[name].primitive === undefined ? (name === 'verifyRecord' ? 'verifyRecord' : `Mailproof#${name}`) : TOOLS[name].primitive) ?? '';

/**
 * The keys without `?` of a required object-literal argument of a method signature (`opts: { before: ..., dryRun?: ... }`).
 * @param {string} sig  `mp.prune(opts: { before: ..., dryRun?: ... }) => ...`
 * @returns {string[]}
 */
export function requiredNames(sig) {
  const open = sig.indexOf('(');
  if (open < 0) return [];
  /** @type {string[]} */
  const parts = [];
  let depth = 0; let cur = ''; let i = open + 1;
  for (; i < sig.length; i++) {
    const c = sig[i];
    if (c === '(' || c === '{' || c === '[' || c === '<') depth++;
    else if (c === '}' || c === ']' || c === '>') depth--;
    else if (c === ')') { if (depth === 0) break; depth--; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  /** @type {string[]} */
  const names = [];
  for (const raw of parts) {
    const m = /^\s*(\w+)(\?)?\s*:\s*([\s\S]*)$/.exec(raw);
    if (!m || m[2]) continue;
    const type = m[3].trim();
    if (!type.startsWith('{')) continue;   // a positional argument: the table flattens and renames those (id, raw, target), so only object-literal keys are checked
    let d = 0; let cur2 = ''; /** @type {string[]} */ const fields = [];
    for (const c of type) {
      if (c === '{' || c === '[' || c === '(' || c === '<') { d++; if (d === 1) continue; } else if (c === '}' || c === ']' || c === ')' || c === '>') { d--; if (d === 0) break; }
      if (c === ',' && d === 1) { fields.push(cur2); cur2 = ''; } else cur2 += c;
    }
    fields.push(cur2);
    for (const f of fields) { const fm = /^\s*(\w+)(\?)?\s*:/.exec(f); if (fm && !fm[2]) names.push(fm[1]); }
  }
  return names;
}

/** @param {string} text @returns {string[]} Every ERR_ code a text names. */
const codesIn = (text) => [...new Set(text.match(/\bERR_[A-Z_]+\b/g) ?? [])];

/**
 * Everything wrong with the table against the library (SPEC B12.4): empty means complete.
 * @param {string[]} [methods]  Public methods of `Mailproof` (the test supplies them from the class).
 * @returns {string[]}
 */
export function problems(methods = []) {
  /** @type {string[]} */
  const out = [];
  const prims = new Map(primitives().map((p) => [p.name, p]));
  const texts = mcpTexts();
  const toolPrims = new Set();
  for (const [name, t] of Object.entries(TOOLS)) {
    const pn = primitiveOf(name);
    if (pn) toolPrims.add(pn);
    const p = pn ? prims.get(pn) : null;
    if (pn && !p) { out.push(`${name}: primitive ${pn} is not in primitives.json`); continue; }
    if (!t.title) out.push(`${name}: no title`);
    for (const h of /** @type {const} */ (['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])) if (typeof t.annotations?.[h] !== 'boolean') out.push(`${name}: annotation ${h} is not set`);
    if (!pn && !t.description) out.push(`${name}: no description`);
    if (pn && !texts.has(pn) && !(p.when && p.fails)) out.push(`${name}: no @when/@fails and no @mcp text`);
    for (const [k, v] of Object.entries(t.params)) if (!v.description) out.push(`${name}.${k}: no description`);
    for (const k of t.required) if (!(k in t.params)) out.push(`${name}: required "${k}" is not a property`);
    if (p) {
      for (const k of Object.keys(t.params)) if (!SERVER_ARGS.has(k) && !p.signature.includes(k)) out.push(`${name}.${k}: not in the method's @signature`);
      for (const r of requiredNames(p.signature)) if (!(r in t.params) && !SERVER_ARGS.has(r) && !['host', 'user', 'auth'].includes(r)) out.push(`${name}: the method requires "${r}" and the schema has no such property`);
    }
  }
  for (const [pn, text] of texts) {
    const p = prims.get(pn);
    if (!p) { out.push(`@mcp ${pn}: no such primitive`); continue; }
    if (!toolPrims.has(pn)) out.push(`@mcp ${pn}: not a tool`);
    if (text.length > MCP_MAX_CHARS) out.push(`@mcp ${pn}: ${text.length} characters, the limit is ${MCP_MAX_CHARS}`);
    for (const c of codesIn(text)) if (!p.fails.includes(c)) out.push(`@mcp ${pn}: names ${c}, which is not in its @fails`);
  }
  for (const p of prims.values()) if (!toolPrims.has(p.name) && !Object.hasOwn(EXCLUDED, p.name)) out.push(`${p.name}: neither a tool nor in EXCLUDED`);
  for (const m of methods) if (!toolPrims.has(`Mailproof#${m}`) && !Object.hasOwn(EXCLUDED, `Mailproof#${m}`)) out.push(`Mailproof#${m}: a public method that is neither a tool nor in EXCLUDED`);
  for (const k of Object.keys(EXCLUDED)) if (!EXCLUDED[k]) out.push(`EXCLUDED.${k}: no reason`);
  return out;
}

export function build() {
  const bad = problems();
  if (bad.length) throw new Error(`gen-mcp-tools: the table is incomplete:\n  ${bad.join('\n  ')}`);
  const prims = new Map(primitives().map((p) => [p.name, p]));
  const texts = mcpTexts();
  const tools = Object.entries(TOOLS).map(([name, t]) => {
    const pn = primitiveOf(name);
    const p = pn ? prims.get(pn) : null;
    const description = pn ? (texts.get(pn) ?? `${p.when} ${p.fails}`) : t.description;
    return {
      name, method: name, cls: t.cls, title: t.title, annotations: t.annotations, description,
      noAccount: Boolean(t.noAccount), required: t.required, properties: t.params,
    };
  });
  return `// GENERATED by scripts/gen-mcp-tools.mjs from src/mcp/tools.js and primitives.json. Do not edit: run npm run build:mcp-tools.\n`
    + `/** @typedef {{ name: string, method: string, cls: 'read' | 'write' | 'destructive', title: string, annotations: import('./tools.js').Annotations, description: string, noAccount: boolean, required: string[], properties: Record<string, import('./tools.js').ParamSpec> }} GeneratedTool */\n`
    + `/** @type {readonly GeneratedTool[]} */\n`
    + `export const GENERATED_TOOLS = Object.freeze(/** @type {GeneratedTool[]} */ (/** @type {unknown} */ (${JSON.stringify(tools, null, 2)})));\n`;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  const text = build();
  if (process.argv.includes('--check')) {
    let have = '';
    try { have = fs.readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    if (have !== text) { console.error('src/mcp/tools.generated.js is stale: run npm run build:mcp-tools and commit it'); process.exit(1); }
    console.log('mcp tools are up to date');
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote src/mcp/tools.generated.js (${Object.keys(TOOLS).length} tools)`);
  }
}
