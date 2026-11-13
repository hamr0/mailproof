// TEST-ONLY. A world for the pair-bundle tests (SPEC B13.2, B13.3): a trail filled with real `record()` calls over signed mail between an
// owner and counterparties, a moving clock, and a fake `ots` binary whose proofs are tiny text files that `ots info` of the same fake reads
// back (the format `verify-bundle` parses is documented in SPEC B13.3.4). No network, no real `ots`. NEVER imported from src/.
import fs from 'node:fs';
import path from 'node:path';
import { Mailproof } from '../../src/proof/mailproof.js';
import { signedMail } from './proof.js';
import { makeTmpDir } from './tmp.js';

export const OWNER = 'owner@owner.example';
export const T0 = Date.parse('2026-11-01T08:00:00Z');
export const DAY = 86_400_000;
export const MERKLE = '2e3d'.repeat(16);

/**
 * A fake `ots`: `stamp` writes `<file>.ots` = `<sha256 of the file>\npending\n`; `upgrade` rewrites line 2 to `anchored` once the
 * `anchored` flag file exists (exit 1 before: still pending); `info` prints the real client's output shape for that proof (and exits 1
 * for a file it cannot read). Every call's argv is logged, so a test can prove `upgrade` and `verify` were never run by verify-bundle.
 */
export function fakeOts() {
  const dir = makeTmpDir('mp-bundle-ots-');
  const bin = path.join(dir, 'ots');
  const flag = path.join(dir, 'anchored');
  const calls = path.join(dir, 'calls.log');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$*" >> '${calls}'
case "$1" in
  stamp) d=$(sha256sum "$2" | cut -d' ' -f1); printf '%s\\npending\\n' "$d" > "$2.ots";;
  upgrade) if [ -f '${flag}' ]; then d=$(sed -n 1p "$2"); printf '%s\\nanchored\\n' "$d" > "$2"; exit 0; else exit 1; fi;;
  info) d=$(sed -n 1p "$2"); s=$(sed -n 2p "$2")
    [ \${#d} -eq 64 ] || exit 1
    echo "File sha256 hash: $d"; echo "Timestamp:"
    if [ "$s" = anchored ]; then echo "verify BitcoinBlockHeaderAttestation(850123)"; echo "# Bitcoin block merkle root ${MERKLE}"
    elif [ "$s" = pending ]; then echo "verify PendingAttestation('https://alice.btc.calendar.opentimestamps.org')"; fi;;
esac
`, { mode: 0o755 });
  return {
    bin, dir,
    anchor: () => fs.writeFileSync(flag, ''),
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []),
  };
}

/**
 * @param {{ otsBin?: string | null, extra?: Record<string, any>, trailDir?: string }} [o]
 */
export function bundleWorld({ otsBin, extra = {}, trailDir = makeTmpDir('mp-bundle-') } = {}) {
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const mk = (more = {}) => new Mailproof({ trailDir, worker: { size: 0 }, now, lockTimeoutMs: 5000, ...(otsBin !== undefined ? { otsBin } : {}), ...extra, ...more });
  const mp = mk();
  /** @type {Array<{ id: string, raw: Buffer, tag: string }>} */
  const recs = [];
  let n = 0;
  /**
   * Record one signed mail. Default: a mail FROM `who` TO the owner (direction in). `out: true`: from the owner to `who`.
   * @param {{ who?: string, tag?: string, out?: boolean, cc?: string, subject?: string, signers?: any[], headerList?: string[], extraHeaders?: string[], body?: string, attachment?: any, advance?: number }} [m]
   */
  const rec = async ({ who = 'bob@bob.example', tag = `m${n++}`, out = false, cc, subject, signers, headerList, extraHeaders = [], body, attachment, advance = 1000 } = {}) => {
    const domain = (out ? OWNER : who).split('@')[1];
    const m = await signedMail({
      domain, from: out ? OWNER : who, to: out ? who : OWNER, subject: subject ?? `subject ${tag}`, body: body ?? `body ${tag}\r\n`,
      signTime: new Date(clock.t), extraHeaders: [...(cc ? [`Cc: ${cc}`] : []), ...extraHeaders], ...(signers ? { signers } : {}), ...(headerList ? { headerList } : {}), ...(attachment ? { attachment } : {}),
    });
    const r = await mk({ resolver: m.resolver }).record(m.raw, { direction: out ? 'out' : 'in', source: 'test' });
    recs.push({ id: r.id, raw: m.raw, tag });
    clock.t += advance;
    return r;
  };
  return { mp, mk, clock, rec, recs, trailDir, root: mp.root, contentDir: `${mp.root}.content`, now };
}

/** @param {string} dir @returns {string[]} Every file under dir, relative, sorted. */
export function treeOf(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d, /** @type {string} */ rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}
