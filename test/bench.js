// Benchmark: generate maps for the reference songs and compare gameplay metrics with the real maps.
// node test/bench.js <scratchpad dir> [brain.json]
const fs = require('fs');
const path = require('path');
const { loadCore } = require('./lib.js');
const { studyMap } = require('./study.js');
const BSM = loadCore();
const S = process.argv[2];
const brainArgs = process.argv.slice(3);   // brain for the ref1 song, brain for the ref2 song

function pcm(f) { const b = fs.readFileSync(path.join(S, f)); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); }

const songs = [
  { name: 'ref1 (Beat Sage, 150)', pcm: 'ref_mono_44k.f32', real: { Expert: ['ref_extract/Expert.dat', 120], ExpertPlus: ['ref_extract/ExpertPlus.dat', 120] } },
  { name: 'ref2 (Astral Quantization, 185)', pcm: 'ref2_mono_44k.f32', real: { Expert: ['ref2/ExpertStandard.dat', 185], ExpertPlus: ['ref2/ExpertPlusStandard.dat', 185] } }
];

const loadBrain = f => BSM.normalizeBrain(JSON.parse(fs.readFileSync(f, 'utf8')));

const keys = ['notes', 'nps', 'chordPct', 'dotPct', 'parityBreakPct', 'sameDirPct', 'sameCellPct', 'dirEntropy', 'onOnsetPct', 'energyCorr', 'walls', 'artWalls', 'bombs'];
const rows = [];
for (const s of songs) {
  const an = BSM.analyzeAudio(pcm(s.pcm), 44100);
  const brain = loadBrain(brainArgs[songs.indexOf(s)] || brainArgs[0]);
  for (const diff of ['Expert', 'ExpertPlus']) {
    const real = BSM.parseDifficulty(JSON.parse(fs.readFileSync(path.join(S, s.real[diff][0]), 'utf8')));
    const rr = studyMap(BSM, real, s.real[diff][1], an);
    const gen = BSM.generateMap(an, { difficulty: diff, seed: 7, candidates: 4 }, brain);
    const gr = studyMap(BSM, gen.map, gen.meta.bpm, an);
    gr.streamShare = gr.stream.shareOfHits; rr.streamShare = rr.stream.shareOfHits;
    gr.longest = gr.stream.longest; rr.longest = rr.stream.longest;
    rows.push({ song: s.name, diff, bpm: an.bpm.toFixed(1), real: rr, gen: gr, spacingReal: rr.spacing, spacingGen: gr.spacing });
  }
}
const cols = keys.concat(['streamShare', 'longest']);
for (const r of rows) {
  console.log('\n' + r.song + ' / ' + r.diff + '  (detected ' + r.bpm + ' BPM)');
  console.log('  metric          real     generated');
  for (const k of cols) console.log('  ' + k.padEnd(15) + String(r.real[k] === undefined ? '-' : (+r.real[k]).toFixed(2)).padStart(8) + String(r.gen[k] === undefined ? '-' : (+r.gen[k]).toFixed(2)).padStart(12));
  console.log('  spacing real', JSON.stringify(r.spacingReal), '\n  spacing gen ', JSON.stringify(r.spacingGen));
}
if (process.env.BENCH_JSON) fs.writeFileSync(process.env.BENCH_JSON, JSON.stringify(rows, null, 1));
