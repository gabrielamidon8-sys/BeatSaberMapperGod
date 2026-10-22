// Synthetic song with known hit times: checks tempo, phase drift and onset recall (incl. machine-gun runs).
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const sr = 44100;
const bpm = +process.argv[2] || 137.37, off = +process.argv[3] || 0.31, secs = 120;
const P = 60 / bpm;
const out = new Float32Array(Math.floor(secs * sr));
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function hit(t, kind) {
  const s0 = Math.round(t * sr);
  const len = kind === 'kick' ? 0.09 : 0.05;
  for (let i = 0; i < len * sr && s0 + i < out.length; i++) {
    const x = i / sr, env = Math.exp(-x * (kind === 'kick' ? 40 : 90));
    const v = kind === 'kick' ? Math.sin(2 * Math.PI * (55 + 120 * Math.exp(-x * 40)) * x) : (rnd() * 2 - 1) * 0.6 + 0.4 * Math.sin(2 * Math.PI * 1800 * x);
    out[s0 + i] += 0.8 * env * v;
  }
}
const truth = [];
// pattern: 8 bars of beats (kick on beats + snare), 4 bars of 1/16-note runs, 4 bars of 1/32 'gatling', repeated
for (let b = 0; off + b * P < secs - 1; b++) {
  const bar = Math.floor(b / 4), sec = bar % 16;
  const t0 = off + b * P;
  hit(t0, 'kick'); truth.push(t0);
  if (b % 2 === 1) { hit(t0, 'snare'); }
  if (sec >= 8 && sec < 12) for (const f of [0.25, 0.5, 0.75]) { hit(t0 + f * P, 'snare'); truth.push(t0 + f * P); }
  else if (sec >= 12) for (const f of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) { hit(t0 + f * P, 'snare'); truth.push(t0 + f * P); }
}
const an = BSM.analyzeAudio(out, sr);
console.log('true bpm', bpm, 'detected', an.bpm.toFixed(3), 'error ppm', ((an.bpm / bpm - 1) * 1e6).toFixed(0), 'drift over song (ms)', ((1 / (an.bpm / bpm) - 1) * secs * 1000).toFixed(1));
const ph = ((off - an.phase) % P + P) % P; console.log('phase error ms', ((ph > P / 2 ? ph - P : ph) * 1000).toFixed(1));
// onset recall by section type
const ts = an.onsetTimes;
const buckets = { quarter: [], sixteenth: [], thirtysecond: [] };
let bias = [];
truth.forEach(t => {
  const b = Math.round((t - off) / P * 8) / 8, k = Math.floor((t - off) / P), sec = Math.floor(k / 4) % 16;
  const key = sec >= 12 ? 'thirtysecond' : sec >= 8 ? 'sixteenth' : 'quarter';
  let best = 1e9; for (const x of ts) { const d = x - t; if (Math.abs(d) < Math.abs(best)) best = d; }
  buckets[key].push(best);
});
for (const k in buckets) { const a = buckets[k]; const hitN = a.filter(d => Math.abs(d) < 0.03).length; const m = a.filter(d => Math.abs(d) < 0.03).reduce((s, d) => s + d, 0) / Math.max(1, hitN); console.log(k, 'recall', (100 * hitN / a.length).toFixed(0) + '%', 'n', a.length, 'mean offset ms', (m * 1000).toFixed(1)); }
// time resolution check of instrument events (kick)
const kb = an.inst.kick.map(e => e.t); let kk = []; truth.filter((t, i) => i % 1 === 0).slice(0, 200).forEach(t => { let best = 1; for (const x of kb) if (Math.abs(x - t) < Math.abs(best)) best = x - t; if (Math.abs(best) < 0.05) kk.push(best); });
console.log('kick event offset ms', (kk.reduce((s, d) => s + d, 0) / Math.max(1, kk.length) * 1000).toFixed(1), 'n', kk.length);
// --- does the generated map follow the hits? (node synth-timing.js bpm off [style])
if (process.argv[4] !== undefined) {
  const brain = JSON.parse(require('fs').readFileSync(__dirname + '/../data/default-brain.json', 'utf8'));
  for (const diff of ['Expert', 'ExpertPlus']) {
    const r = BSM.generateMap(an, { difficulty: diff, style: process.argv[4] || 'balanced', seed: 11, candidates: 2 }, brain);
    const nt = r.map.notes.map(n => n.time * an.period).sort((a, b) => a - b);
    const bk = { quarter: [0, 0], sixteenth: [0, 0], thirtysecond: [0, 0] };
    truth.forEach(t => {
      const k = Math.floor((t - off) / P), sec = Math.floor(k / 4) % 16, key = sec >= 12 ? 'thirtysecond' : sec >= 8 ? 'sixteenth' : 'quarter';
      let ok = false; for (const x of nt) { if (Math.abs(x - t) < 0.03) { ok = true; break; } if (x > t + 0.1) break; }
      bk[key][1]++; if (ok) bk[key][0]++;
    });
    console.log(diff, 'notes', nt.length, 'nps', (nt.length / an.duration).toFixed(2), Object.entries(bk).map(([k, v]) => k + ' ' + Math.round(100 * v[0] / v[1]) + '%').join('  '));
  }
}
if (process.argv[5] === 'dbg') {
  const brain = JSON.parse(require('fs').readFileSync(__dirname + '/../data/default-brain.json', 'utf8'));
  const r = BSM.generateMap(an, { difficulty: 'Expert', style: 'balanced', seed: 11, candidates: 1 }, brain);
  const nt = r.map.notes.map(n => n.time * an.period);
  let shown = 0, byBar = {};
  truth.forEach(t => {
    const k = Math.floor((t - off) / P), sec = Math.floor(k / 4) % 16; if (sec >= 8) return;
    const ok = nt.some(x => Math.abs(x - t) < 0.03);
    const bi = Math.floor(k / 4); byBar[bi] = byBar[bi] || [0, 0]; byBar[bi][1]++; if (ok) byBar[bi][0]++;
  });
  console.log('per-bar covered/total (quarter bars):', Object.entries(byBar).slice(0, 40).map(([b, v]) => b + ':' + v[0] + '/' + v[1]).join(' '));
  console.log('beatEnergy sample', Array.from(an.beatEnergy.slice(0, 40)).map(x => x.toFixed(2)).join(' '));
}
