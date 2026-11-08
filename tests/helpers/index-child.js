// TEST-ONLY child process, run with better-sqlite3 unloadable (no-sqlite-register.js). Records a mail, reads and
// verifies it, then asks for list() and copies(). Prints one JSON line.
// argv: <trailDir> <mailFile> <resolverMapFile>
import fs from 'node:fs';
import { Mailproof } from '../../src/index.js';

const [trailDir, mailFile, mapFile] = process.argv.slice(2);
const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
const resolver = async (name) => {
  if (map[name] === undefined) throw Object.assign(new Error('no record ' + name), { code: 'ENOTFOUND' });
  return [[map[name]]];
};
const mp = new Mailproof({ trailDir, resolver, worker: { size: 0 } });
const code = async (p) => { try { await p; return null; } catch (e) { return e.code ?? String(e.message); } };
const raw = fs.readFileSync(mailFile);
const rec = await mp.record(raw, { direction: 'in', source: 'child' });
const got = await mp.get(rec.id);
const ver = await mp.verify(rec.id);
const chk = await mp.check(raw);
const mb = await mp.matchBody(rec.id, raw);
process.stdout.write(JSON.stringify({
  recorded: !rec.duplicate, got: got?.id === rec.id, verified: ver.ok, checked: chk.live.trust, matched: mb.match,
  list: await code(mp.list()), copies: await code(mp.copies(rec.id)),
}) + '\n');
