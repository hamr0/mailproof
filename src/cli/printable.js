// Terminal-safe text (SPEC B11.7, F28). The implementation lives in src/proof/printable.js because the library's own text
// output (the pair bundle's README, B13.2.10) needs it too; the CLI keeps importing it from here.
export { printable } from '../proof/printable.js';
