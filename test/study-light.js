// What does the lighting do? node test/study-light.js <mono.f32> <brain.json>
const fs = require('fs');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const b = fs.readFileSync(process.argv[2]);
const an = BSM.analyzeAudio(new Float32Array(b.buffer, b.byteOffset, b.length / 4), 44100);
const brain = BSM.normalizeBrain(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')));
const m = BSM.analyzeMood(an);
m.sections.forEach((s, i) => console.log('section', i, s.emotion.padEnd(10), 'A', s.A.toFixed(2), 'B', s.B.toFixed(2), an.sections[i].drop ? 'DROP' : ''));
console.log('builds', JSON.stringify(m.builds));
const r = BSM.generateMap(an, { difficulty: 'Expert', seed: 3, candidates: 1 }, brain);
const ev = r.map.events, byType = {};
ev.forEach(e => byType[e.type] = (byType[e.type] || 0) + 1);
console.log('v2 events', ev.length, JSON.stringify(byType));
const l4 = r.map.lights4;
console.log('v4 groups', l4 ? l4.groups.length : 0, 'boosts', l4 ? l4.boosts.length : 0);
if (l4) { const ls = BSM.buildLightshow4(l4); console.log('lightshow groups', ls.eventBoxGroups.length, 'color events', ls.lightColorEvents.length); }
