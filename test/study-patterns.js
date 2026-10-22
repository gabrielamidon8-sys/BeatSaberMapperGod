// How tech is it? Counts pattern use and technicality of generated vs real maps.  node test/study-patterns.js <mono.f32> <brain.json> [style] [tech]
const fs = require('fs');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const b = fs.readFileSync(process.argv[2]);
const an = BSM.analyzeAudio(new Float32Array(b.buffer, b.byteOffset, b.length / 4), 44100);
const brain = BSM.normalizeBrain(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
const style = process.argv[4] || 'balanced', tech = process.argv[5] ? +process.argv[5] : 1;
console.log('library', brain.patterns.list.length, 'mined motifs; top tech', brain.patterns.list.slice(0).sort((a, b) => b.t - a.t).slice(0, 3).map(e => e.t));
for (const diff of ['Hard', 'Expert', 'ExpertPlus']) {
  const r = BSM.generateMap(an, { difficulty: diff, seed: 5, candidates: 2, style, tech }, brain);
  const notes = r.map.notes;
  const moments = [];
  for (const n of notes) { const l = moments[moments.length - 1]; if (l && Math.abs(l.t - n.time) < 1e-4) l.n.push([n.color, n.lane, n.layer, n.dir]); else moments.push({ t: n.time, n: [[n.color, n.lane, n.layer, n.dir]] }); }
  let sc = 0, cnt = 0;
  for (let i = 0; i + 4 <= moments.length; i += 4) { sc += BSM.techScore(moments.slice(i, i + 4).map(m => [m.t - moments[i].t, m.n])); cnt++; }
  const stacks = moments.filter(m => m.n.length >= 2 && m.n.every(n => n[0] === m.n[0][0])).length;
  const v = BSM.validateMap(r.map, an.bpm);
  console.log(diff.padEnd(10), 'notes', notes.length, 'nps', r.meta.stats.nps.toFixed(2), 'stream hits', r.meta.streamHits, 'tech(avg 4-moment)', (sc / cnt).toFixed(3), 'same-hand stacks', stacks, 'reach viol', v.reachViolations, 'errors', v.errors.length, 'critic', r.meta.critic.toFixed ? r.meta.critic.toFixed(2) : JSON.stringify(r.meta.critic).slice(0, 40));
}
