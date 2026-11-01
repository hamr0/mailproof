// POC: every input bound in ONE place. Values are provisional until 03-samples/04-caps justify them.
export const LIMITS = Object.freeze({
  MAX_HEADER_BYTES: 256 * 1024,    // header-only cost ~0.27 ms/KiB linear (68 ms unfolded, 189 ms signed no-@ From at 256 KiB); real max 17 KiB
  MAX_HEADER_LINES: 4000,          // physical lines incl. folds; real max 212
  MAX_HEADER_FIELDS: 1000,         // unfolded fields (same as src/proof/signed-headers.js)
  MAX_SIGNATURES: 10,              // DKIM-Signature fields (src evaluates the first 10; the gate REJECTS beyond)
  MAX_H_NAMES: 200,                // names in one h= (same as src)
  MAX_MIME_PARTS: 200,           // "--" lines: parts cost is SUPER-linear (tiny parts 52/66/187/587 ms at 100/200/400/800); real max 17
  MAX_SIG_BYTES: 16 * 1024,        // ONE DKIM-Signature field incl. folds: padded b=/bh= is ~quadratic (17/38/147/668 ms at 4/16/64/256 KiB)
  MAX_BODY_LINE: 256 * 1024,       // tab/space-run line, wrong bh: 64K/128K/256K/512K/1M = 39/64/139/398/838 ms (super-linear); matching-bh 1 MiB = 268 ms
});
