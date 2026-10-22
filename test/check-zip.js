const fs = require('fs');
const { execFileSync } = require('child_process');
const zlib = require('zlib');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const S = process.argv[2];
const REF_ZIP = process.argv[3];
const outDir = S + '/gen';
const env = {
  inflateRaw: async (b) => new Uint8Array(zlib.inflateRawSync(Buffer.from(b))),
  decodeAudio: async (bytes) => {
    const tmp = S + '/tmp_song.ogg';
    fs.writeFileSync(tmp, Buffer.from(bytes));
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', tmp, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    return { samples: new Float32Array(samples), sr: 44100 };
  }
};
(async () => {
  const brain = BSM.emptyBrain();
  const zipBytes = new Uint8Array(fs.readFileSync(REF_ZIP));
  const report = await BSM.learnFromZip(zipBytes, brain, env);
  console.log('learned:', JSON.stringify(report));
  console.log('brain summary:', JSON.stringify(BSM.summarizeBrain(brain)));
  // export a generated map as a playable zip
  const an = BSM.analyzeAudio(new Float32Array(fs.readFileSync(S + '/ref_mono_44k.f32').buffer), 44100);
  const gen = BSM.generateMap(an, { difficulty: 'Expert', seed: 42, candidates: 2 }, brain);
  const info = BSM.makeInfo({ songName: 'Stamp On The Ground', artist: 'Italo Brothers', mapper: 'BeatForge test', bpm: an.bpm, difficulties: [{ name: 'Expert' }] });
  const zip = BSM.buildMapZip({ info: info, maps: { Expert: gen.map }, audio: null, cover: null });
  fs.writeFileSync(outDir + '/export_test.zip', zip);
  // read it back through our own reader
  const files = await BSM.unzipAll(zip, env.inflateRaw);
  console.log('our zip entries:', Array.from(files.keys()).join(', '));
  const back = BSM.parseDifficulty(JSON.parse(BSM.bytesToText(files.get('Expert.dat'))));
  console.log('round trip notes', back.notes.length, 'vs', gen.map.notes.length, 'walls', back.walls.length, 'vs', gen.map.walls.length, 'bombs', back.bombs.length, 'vs', gen.map.bombs.length, 'events', back.events.length, 'vs', gen.map.events.length);
  console.log('validate round-trip:', JSON.stringify(BSM.validateMap(back).errors));
  console.log('first note sample', JSON.stringify(BSM.toV2(gen.map)._notes[0]));
  console.log('info bpm', BSM.parseInfo(JSON.parse(BSM.bytesToText(files.get('Info.dat')))).bpm);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
