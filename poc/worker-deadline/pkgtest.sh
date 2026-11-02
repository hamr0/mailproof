#!/bin/sh
# Package-import test: a consumer imports mailproof from node_modules (a symlink, like `npm i file:../mailproof`) and the pool's
# worker file is resolved with new URL('./worker.js', import.meta.url). Also: does `node script.js` exit by itself with an idle pool?
set -e
SCR=${WD_DIR:-${TMPDIR:-/tmp}/mailproof-worker-deadline}
D=$SCR/pkg; rm -rf $D; mkdir -p $D/consumer/node_modules $D/pkgs
# the "published package": frozen tree + worker/pool beside mailproof.js (where the real feature would live), deps via symlink
mkdir -p $D/pkgs/mailproof; (cd $SCR/wd-src && cp -r package.json src $D/pkgs/mailproof/); ln -s $SCR/wd-src/node_modules $D/pkgs/mailproof/node_modules
HERE=$(dirname "$(readlink -f "$0")")
cp $HERE/pool.js $D/pkgs/mailproof/src/proof/deadline-pool.js
# worker imports ./mailproof.js relatively, not through workerData
sed "s|await import(workerData.mailproofUrl)|await import('./mailproof.js')|" $HERE/worker.js > $D/pkgs/mailproof/src/proof/worker.js
sed -i "s|new URL('./worker.js'|new URL('./worker.js'|" $D/pkgs/mailproof/src/proof/deadline-pool.js
cat > $D/pkgs/mailproof/src/wd-entry.js <<'EOT'
import { DeadlinePool } from './proof/deadline-pool.js';
export { DeadlinePool };
export { Mailproof } from './index.js';
EOT
node -e "const f='$D/pkgs/mailproof/package.json';const p=JSON.parse(require('fs').readFileSync(f));p.exports['./wd']='./src/wd-entry.js';require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
ln -s $D/pkgs/mailproof $D/consumer/node_modules/mailproof
cat > $D/consumer/run.mjs <<'EOT'
import { Mailproof, DeadlinePool } from 'mailproof/wd';
const mailproofUrl = import.meta.resolve('mailproof');
const mp = new Mailproof({ trailDir: './t' });
const pool = new DeadlinePool({ size: 2, deadlineMs: 5000, mailproofUrl: new URL('./src/proof/mailproof.js', mailproofUrl).href, resolver: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } });
const raw = Buffer.from('From: a@b.example\r\nSubject: s\r\n\r\nhi\r\n');
const r = await pool.run(raw, { ctx: { direction: 'in', source: 'pkg' }, captured: new Date().toISOString(), trustedSealers: [] });
console.log('worker from package ok:', r.ok, r.ok && r.out.record.message.size, 'workers alive (idle):', pool.all.size);
// no pool.close(): the idle pool must not keep the process alive
EOT
cd $D/consumer
S=$(date +%s%N); timeout 20 node run.mjs; echo "exit=$? after $((($(date +%s%N)-S)/1000000)) ms (no close(), idle pool left open)"
