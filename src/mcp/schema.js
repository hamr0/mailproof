// A small JSON Schema checker for the flat schemas of tools.js (SPEC B12.4): `type` (one name or a list), `enum`,
// `minimum`, `maximum`, `minItems`, `maxItems`, `items`, `required`, `properties` and `additionalProperties: false`.
// Nothing else is supported because nothing else is generated.

/** @param {unknown} v @returns {string} The JSON type name of a value. */
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

/** @param {unknown} v @param {string} type @returns {boolean} */
const isType = (v, type) => (type === 'number' ? typeof v === 'number' && Number.isFinite(v) : type === 'integer' ? Number.isInteger(v) : typeOf(v) === type);

/**
 * @param {Record<string, any>} schema
 * @param {unknown} value
 * @param {string} [at]  The name of the value in messages.
 * @returns {string | null}  The first problem, or null when the value fits.
 */
export function validate(schema, value, at = 'arguments') {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(value, t))) return `${at} must be ${types.map((t) => (t === 'integer' ? 'a whole number' : `a ${t}`)).join(' or ')}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(', ')}`;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${at} needs at least ${schema.minItems} item(s)`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} takes at most ${schema.maxItems} items`;
    if (schema.items) for (let i = 0; i < value.length; i++) { const p = validate(schema.items, value[i], `${at}[${i}]`); if (p) return p; }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value);
    for (const k of schema.required ?? []) if (!(k in obj)) return `missing "${k}"`;
    if (schema.properties) {
      for (const [k, v] of Object.entries(obj)) {
        const sub = Object.hasOwn(schema.properties, k) ? schema.properties[k] : null;
        if (!sub) { if (schema.additionalProperties === false) return `unknown argument "${k}"`; continue; }
        const p = validate(sub, v, `"${k}"`);
        if (p) return p;
      }
    }
  }
  return null;
}
