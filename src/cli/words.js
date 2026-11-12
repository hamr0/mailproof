// Plain words for screens (SPEC B11.4c): one definition of plurals, sizes and wrapped text, so no screen writes `record(s)` or `1 records`.

/**
 * `1 record`, `3 records`. The plural is the singular plus `s` unless one is given.
 * @param {number} n @param {string} one @param {string} [many]
 * @returns {string}
 */
export const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A size in plain units: bytes under 1 KiB, then KiB and MiB with one decimal.
 * @param {number} n
 * @returns {string}
 */
export const humanSize = (n) => (n < 1024 ? count(n, 'byte') : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

/**
 * Wrap plain text at spaces into lines of at most `width` code points (a longer word is cut). The text must not be styled.
 * @param {string} text @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
  const w = Math.max(8, width);
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while ([...rest].length > w) {
      if (line) { lines.push(line); line = ''; }
      lines.push([...rest].slice(0, w).join(''));
      rest = [...rest].slice(w).join('');
    }
    if (!line) line = rest;
    else if ([...line].length + 1 + [...rest].length <= w) line += ` ${rest}`;
    else { lines.push(line); line = rest; }
  }
  if (line) lines.push(line);
  return lines;
}
