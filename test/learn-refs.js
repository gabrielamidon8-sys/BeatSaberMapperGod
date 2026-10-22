// Learn from reference map zips (with their audio) into a brain file.
// node test/learn-refs.js <out brain.json> <map.zip> [more.zip ...]
// Audio is decoded with ffmpeg (node has no audio decoder); the browser app uses Web Audio instead.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { loadCore } = require('./lib.js');
const BSM = loadCore();

const [out, ...zips] = process.argv.slice(2);
if (!out || !zips.length) { console.error('usage: node test/learn-refs.js <out.json> <map.zip> ...'); process.exit(2); }

const env = {
  inflateRaw: async b => new Uint8Array(zlib.inflateRawSync(Buffer.from(b))),
  decodeAudio: async bytes => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsm-'));
    const src = path.join(dir, 'in.audio'), dst = path.join(dir, 'out.f32');
    fs.writeFileSync(src, Buffer.from(bytes));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '44100', '-f', 'f32le', dst]);
    const b = fs.readFileSync(dst);
    fs.rmSync(dir, { recursive: true, force: true });
    return { samples: new Float32Array(b.buffer, b.byteOffset, b.length / 4), sr: 44100 };
  }
};

(async () => {
  const brain = BSM.emptyBrain();
  for (const z of zips) {
    const rep = await BSM.learnFromZip(new Uint8Array(fs.readFileSync(z)), brain, env);
    console.log(path.basename(z).slice(0, 50), JSON.stringify(rep));
  }
  fs.writeFileSync(out, JSON.stringify(brain));
  console.log('summary', JSON.stringify(BSM.summarizeBrain(brain)));
  console.log('brain bytes', fs.statSync(out).size);
})().catch(e => { console.error(e); process.exit(1); });
