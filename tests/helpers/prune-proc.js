// TEST-ONLY child process: runs `Mailproof#prune` and kills itself (SIGKILL, no cleanup runs) at a named point, to
// prove crash recovery with a real dead process. argv: <trailDir> <before ISO> <crashAt>
// crashAt: `afterBuild` (the pruned trail is built, nothing is locked) or a swap point: `journal`, `renamed-live`,
// `renamed-tmp`, `cursor`, `swapped`. Prints one JSON line when it is not killed.
import { Mailproof } from '../../src/proof/mailproof.js';

const [trailDir, before, crashAt] = process.argv.slice(2);
const mp = new Mailproof({ trailDir, worker: { size: 0 }, now: () => new Date('2026-02-01T00:00:00Z') });
const die = () => process.kill(process.pid, 'SIGKILL');
if (crashAt === 'afterBuild') mp._pruneHooks.afterBuild = die;
else mp._pruneHooks.point = (name) => { if (name === crashAt) die(); };
try {
  const r = await mp.prune({ before });
  process.stdout.write(JSON.stringify({ ok: true, removed: r.removed }) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, code: e.code, message: String(e.message) }) + '\n');
  process.exitCode = 1;
}
