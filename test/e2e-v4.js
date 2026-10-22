// Generate with the shipped brain and export both formats; re-read what was written.
const fs = require('fs'), path = require('path');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const S = process.argv[2];
const b = fs.readFileSync(path.join(S, 'ref2_mono_44k.f32'));
const pcm = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
const an = BSM.analyzeAudio(pcm, 44100);
const brain = BSM.normalizeBrain(JSON.parse(fs.readFileSync(path.join(S, 'beat-mapper/data/default-brain.json'), 'utf8')));
const maps = {};
for (const d of ['Hard', 'Expert']) maps[d] = BSM.generateMap(an, { difficulty: d, seed: 11 }, brain).map;
const zip = BSM.buildMapZip({ format: 'v4', maps, audio: null, cover: null, sampleCount: pcm.length, frequency: 44100,
  meta: { songName: 'e2e', artist: 'x', mapper: 'BeatForge', bpm: an.bpm, duration: an.duration } });
const files = BSM.unzipAll ? null : null;
fs.writeFileSync(path.join(S, 'smoke/e2e-v4.zip'), zip);
console.log('v4 zip bytes', zip.length, 'light groups', maps.Expert.lights4 ? maps.Expert.lights4.groups.length : 'none');
const v2 = BSM.buildMapZip({ info: BSM.makeInfo({ songName: 'e2e', artist: '', mapper: 'BeatForge', bpm: an.bpm, songFile: 'song.ogg', coverFile: 'cover.jpg', difficulties: [{ name: 'Expert' }] }), maps: { Expert: maps.Expert }, audio: null, cover: null });
console.log('v2 zip bytes', v2.length);
