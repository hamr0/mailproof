// Builds a throwaway trail from synthetic signed mail (the test helper builds it; no real mail anywhere).
// `node trail.mjs <outDir>` copies it (trail + its .content store) to a persistent dir for a real-client run.
import fs from 'node:fs';
import { buildThread } from '../../tests/helpers/thread-trail.js';

export async function buildTrail() {
  const t = await buildThread();
  return { dir: t.dir, ids: { req: t.r.req.id, signed: t.r.signed.id }, reqMessageId: '<req@owner.example>', mp: t.mp };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  const t = await buildTrail();
  await t.mp.close();
  fs.mkdirSync(out, { recursive: true });
  for (const n of fs.readdirSync(t.dir)) fs.cpSync(`${t.dir}/${n}`, `${out}/${n}`, { recursive: true });
  console.log(JSON.stringify({ out, ids: t.ids, reqMessageId: t.reqMessageId }));
  process.exit(0); // makeTmpDir's exit handler removes the build dir
}
