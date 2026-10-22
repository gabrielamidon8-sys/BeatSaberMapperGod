const fs = require('fs');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const S = process.argv[2];
const buf = fs.readFileSync(S + '/ref_mono_44k.f32');
const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const a = BSM.analyzeAudio(samples, 44100);
const info = BSM.parseInfo(JSON.parse(fs.readFileSync(S + '/ref_extract/Info.dat', 'utf8')));
const ref = BSM.parseDifficulty(JSON.parse(fs.readFileSync(S + '/ref_extract/ExpertPlus.dat', 'utf8')));
const refTimes = ref.notes.map(n => n.time * 60 / info.bpm);   // seconds
// 1) phase histogram of reference notes against OUR grid at 1/48 resolution (period a.period)
const H = new Array(48).fill(0);
for (const t of refTimes) H[Math.floor((((t - a.phase) / a.period) % 1 + 1) % 1 * 48)]++;
console.log('ref notes vs our grid, 48 bins/beat:', H.join(','));
// 2) onset-alignment score of reference notes as a function of grid phase shift
const scoreAt = (shift) => {
  let s = 0;
  for (const t of refTimes) s += BSM.onsetAt(a, t + shift, 0.02);
  return s / refTimes.length;
};
let bestShift = 0, bestS = -1;
const rows = [];
for (let sh = -0.2; sh <= 0.2001; sh += 0.01) { const s = scoreAt(sh); rows.push(sh.toFixed(2) + ':' + s.toFixed(3)); if (s > bestS) { bestS = s; bestShift = sh; } }
console.log('onset score vs shift (s):', rows.join(' '));
console.log('best shift for reference notes:', bestShift.toFixed(3), 's score', bestS.toFixed(3), ' (random baseline', (()=>{let s=0,n=0;for(let t=5;t<190;t+=0.137){s+=BSM.onsetAt(a,t,0.02);n++;}return (s/n).toFixed(3)})(), ')');
console.log('our phase', a.phase.toFixed(4), 'period', a.period.toFixed(5));
// 3) strongest onset positions in time mod period (where do onsets actually fall)
const hist = new Array(24).fill(0);
for (let f = 0; f < a.onset.length; f++) if (a.onset[f] > 0.5) { const t = f / a.fps; hist[Math.floor((((t - a.phase) / a.period) % 1 + 1) % 1 * 24)]++; }
console.log('strong onsets vs grid (24 bins/beat):', hist.join(','));
