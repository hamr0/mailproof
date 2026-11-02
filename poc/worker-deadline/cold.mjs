import { DeadlinePool } from './pool.js'; import { mailproofUrl } from './wm.js';
const ts = [], im = [];
for (let i = 0; i < 6; i++) { const p = new DeadlinePool({ size: 1, mailproofUrl }); const t0 = performance.now(); const w = p._spawn(); await w.ready; ts.push(performance.now() - t0); await p.close(); }
const t0 = performance.now(); await import('mailauth'); await import('mailparser'); 
console.log('worker spawn->ready (imports mailauth+mailparser+mailproof) ms:', ts.map((x) => Math.round(x)).join(' '), '| main-thread cached import', Math.round(performance.now() - t0));
