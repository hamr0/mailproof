export const cpu = async (fn) => { const c0 = process.cpuUsage(); const r = await fn(); const c = process.cpuUsage(c0); return { ms: (c.user + c.system) / 1000, r }; };
export const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
/** warm-up then median of k CPU timings (ms) */
export async function timeIt(fn, k = 3) { await fn(); const ts = []; for (let i = 0; i < k; i++) ts.push((await cpu(fn)).ms); return median(ts); }
export const nxdomain = async () => { throw Object.assign(new Error('no record'), { code: 'ENOTFOUND' }); };
