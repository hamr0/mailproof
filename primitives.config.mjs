import { basename } from 'node:path';
function inferCategory(file) {
  const b = basename(file, '.js');
  if (b === 'mailproof' || b === 'index') return 'proof';
  if (b === 'recheck') return 'verify';
  return b;
}
export default {
  inferCategory,
  sourceRoots: ['src'],
  receivers: { Mailproof: 'mp' },
};
