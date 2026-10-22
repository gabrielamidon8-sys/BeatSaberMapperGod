const fs = require('fs');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const S = process.argv[2];
const outDir = process.argv[3] || (S + '/gen');
fs.mkdirSync(outDir, { recursive: true });
const buf = fs.readFileSync(S + '/ref_mono_44k.f32');
const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const t0 = Date.now();
const an = BSM.analyzeAudio(samples, 44100);
console.log('analysis', Date.now() - t0, 'ms  bpm', an.bpm.toFixed(2), 'sections', an.sections.length);
const info = BSM.parseInfo(JSON.parse(fs.readFileSync(S + '/ref_extract/Info.dat', 'utf8')));
let brain = BSM.emptyBrain();
for (const d of info.difficulties) {
  const obj = JSON.parse(fs.readFileSync(S + '/ref_extract/' + d.file, 'utf8'));
  const map = BSM.parseDifficulty(obj);
  BSM.learnFromMap(brain, map, { name: 'Beat Sage: Stamp On The Ground', difficulty: d.name, bpm: info.bpm }, an);
}
console.log('brain summary', JSON.stringify(BSM.summarizeBrain(brain)));
console.log('dirCount', brain.dirCount.join(','));
console.log('npb', JSON.stringify(brain.npb));
fs.writeFileSync(outDir + '/brain.json', JSON.stringify(brain));
const pri = BSM.priors(brain);
console.log('densityMul at e=0,0.5,1:', [0, 0.5, 1].map(e => pri.densityMul(e).toFixed(2)).join(' '));
console.log('chordRate at e=0.2,0.9:', [0.2, 0.9].map(e => { const c = pri.chordRate(e); return c === null ? 'n/a' : c.toFixed(3); }).join(' '));
for (const diff of BSM.DIFFICULTIES) {
  const t1 = Date.now();
  const gen = BSM.generateMap(an, { difficulty: diff, seed: 12345, candidates: 4 }, brain);
  const st = gen.meta.stats, v = gen.meta.validation;
  console.log(`${diff.padEnd(10)} ${Date.now()-t1}ms notes=${st.notes} nps=${st.nps.toFixed(2)} peakNps=${st.peakNps.toFixed(2)} dots=${st.dots} chords=${st.chordBeats} bombs=${st.bombs} walls=${st.walls}(full ${st.fullWalls}/crouch ${st.crouchWalls}) events=${st.events} | errors=${v.errors.length} warnings=${v.warnings.join('; ') || 'none'} score=${gen.meta.score.toFixed(2)} seed=${gen.meta.seed} skipped=${gen.meta.skipped}`);
  console.log('   dirs', st.dirs.join(','), ' cells(layer0..2 x lane)', JSON.stringify(st.cells));
  const out = BSM.toV2(gen.map);
  fs.writeFileSync(outDir + '/' + diff + '.dat', JSON.stringify(out));
  if (v.errors.length) console.log('   ERRORS:', v.errors.slice(0, 5).join(' | '));
}
