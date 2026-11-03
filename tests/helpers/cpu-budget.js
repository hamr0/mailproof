// Calibrates a worker CPU budget on the running machine, so a test never depends on how fast the box is.
// Measures the worker CPU (Worker#cpuUsage) of (a) an ordinary signed message as the FIRST job on a fresh worker
// (cold JIT) and (b) the SLOW worst case, then takes the geometric mean: equal slack both ways. A budget there kills
// SLOW and never kills an ordinary message on a fresh worker. No test asserts a raw time.
import { WorkerPool, workerConfig } from '../../src/proof/pool.js';
import { signedMail } from './proof.js';
import { WORST_CASES } from './worst-cases.js';

export const SLOW = '10 valid signatures, tampered 500,000 one-byte bare-LF lines';
const MIN_RATIO = 4;

async function measure() {
  const pool = new WorkerPool(workerConfig({ cpuMs: 1e9, wallMs: 1e9 }));
  try {
    const input = { ctx: { direction: 'in', source: 'calibrate' }, captured: new Date().toISOString(), hasEnvelope: false, trustedSealers: [] };
    const ord = await signedMail({ body: 'hello\r\n' });
    const slow = await WORST_CASES.find((c) => c.name === SLOW).build();
    const cold = (await pool.run(ord.raw, input, ord.resolver)).cpuMs;   // first job on a fresh worker
    const slowMs = (await pool.run(slow.raw, input, slow.resolver)).cpuMs;
    return { ordinaryCold: cold, slow: slowMs };
  } finally {
    await pool.close();
  }
}

const m = await measure();
const ratio = m.slow / m.ordinaryCold;
if (!(ratio >= MIN_RATIO)) {
  throw new Error(`CPU calibration premise broken: SLOW costs ${m.slow.toFixed(0)} ms of worker CPU, an ordinary cold job ${m.ordinaryCold.toFixed(0)} ms (ratio ${ratio.toFixed(1)}, need >= ${MIN_RATIO}); no budget separates them`);
}
/** CPU budget in ms that kills SLOW but not an ordinary message on a fresh worker, on this machine. */
export const SLOW_CPU_MS = Math.round(Math.sqrt(m.ordinaryCold * m.slow));
export const CALIBRATION = { ...m, budget: SLOW_CPU_MS };
console.log(`# cpu-budget calibration: ordinaryCold=${m.ordinaryCold.toFixed(1)} ms slow=${m.slow.toFixed(1)} ms budget=${SLOW_CPU_MS} ms`);
