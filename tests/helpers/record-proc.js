// TEST-ONLY child process: records one mail file into a trail, prints one JSON
// line ({ ok, id, duplicate } or { ok:false, code, message }). Used to prove the
// cross-process writer lock with real separate processes.
// argv: <trailDir> <mailFile> <resolverMapFile> [lockTimeoutMs]
import fs from 'node:fs';
import { Mailproof } from '../../src/proof/mailproof.js';

const [trailDir, mailFile, mapFile, timeout] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const resolver = async (name, type) => {
  if ((type || 'TXT').toUpperCase() !== 'TXT') throw Object.assign(new Error('only TXT'), { code: 'ENODATA' });
  if (map[name] === undefined) throw Object.assign(new Error('no record ' + name), { code: 'ENOTFOUND' });
  return [[map[name]]];
};
const mp = new Mailproof({ trailDir, resolver, ...(timeout ? { lockTimeoutMs: Number(timeout) } : {}) });
// No process.exit: the child must end on its own once record() is done (a lingering timer shows up as a slow test).
const finish = (line, code) => { process.stdout.write(JSON.stringify(line) + '\n'); process.exitCode = code; };
try {
  const r = await mp.record(fs.readFileSync(mailFile), { direction: 'in', source: 'proc' });
  finish({ ok: true, id: r.id, duplicate: r.duplicate }, 0);
} catch (e) {
  finish({ ok: false, code: e.code || null, message: String(e.message) }, 1);
}
