const fs = require('fs');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const S = process.argv[2];
const buf = fs.readFileSync(S + '/ref_mono_44k.f32');
const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
let t0 = Date.now();
const a = BSM.analyzeAudio(samples, 44100);
console.log('analysis ms', Date.now() - t0);
console.log('bpm', a.bpm.toFixed(3), 'confidence', a.tempoConfidence.toFixed(3), 'period', a.period.toFixed(5), 'phase', a.phase.toFixed(4), 'downbeat', a.downbeat, 'beats', a.beatCount, 'duration', a.duration.toFixed(2));
console.log('sections:', a.sections.map(s => `[${s.start}-${s.end} ${s.level}${s.drop ? ' DROP' : ''} e=${s.energy.toFixed(2)}]`).join(' '));
// Compare reference note times with the detected grid (in beats = time/period)
const info = BSM.parseInfo(JSON.parse(fs.readFileSync(S + '/ref_extract/Info.dat', 'utf8')));
for (const d of ['ExpertPlus', 'Normal']) {
  const map = BSM.parseDifficulty(JSON.parse(fs.readFileSync(S + '/ref_extract/' + d + '.dat', 'utf8')));
  let on12 = 0, onDown = 0, n = 0;
  for (const note of map.notes) {
    const frac = ((note.time % 1) + 1) % 1;
    const best = Math.min(...[0, 1 / 12, 2 / 12, 3 / 12, 4 / 12, 5 / 12, 6 / 12, 7 / 12, 8 / 12, 9 / 12, 10 / 12, 11 / 12, 1].map(g => Math.abs(frac - g)));
    n++; if (best < 0.02) on12++;
  }
  console.log(d, 'notes', n, 'within 0.02 beat of a 1/12 grid line:', (on12 / n * 100).toFixed(1) + '%');
}
// Reference note beat -> our grid: compare reference notes' seconds vs our beat phase
const refMap = BSM.parseDifficulty(JSON.parse(fs.readFileSync(S + '/ref_extract/ExpertPlus.dat', 'utf8')));
const bpmRef = info.bpm;
let phaseHist = new Array(10).fill(0);
for (const note of refMap.notes) {
  const tSec = note.time * 60 / bpmRef;               // reference beat -> seconds
  const ourBeat = (tSec - a.phase) / a.period;         // our beat index (fractional)
  const frac = ((ourBeat % 1) + 1) % 1;
  phaseHist[Math.min(9, Math.floor(frac * 10))]++;
}
console.log('reference note phase vs our detected beat grid (deciles):', phaseHist.join(' '));
console.log('first 12 beat times (s):', Array.from(a.beatTimes.slice(0, 12)).map(x => x.toFixed(3)).join(' '));
console.log('beat energy (first 40):', Array.from(a.beatEnergy.slice(0, 40)).map(x => x.toFixed(2)).join(' '));
