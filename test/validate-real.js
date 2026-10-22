// Real-map validation: how well do tempo, beat grid and onsets match the human map made for the song?
// node test/validate-real.js zip...
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const infl = async b => new Uint8Array(zlib.inflateRawSync(Buffer.from(b)));
function decode(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsm-')), src = path.join(dir, 'in.audio'), dst = path.join(dir, 'o.f32');
  fs.writeFileSync(src, Buffer.from(bytes));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '44100', '-f', 'f32le', dst]);
  const b = fs.readFileSync(dst); fs.rmSync(dir, { recursive: true, force: true });
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
(async () => {
  for (const z of process.argv.slice(2)) {
    const files = await BSM.unzipAll(new Uint8Array(fs.readFileSync(z)), infl);
    const info = BSM.parseInfo(JSON.parse(BSM.bytesToText(BSM.findFile(files, 'Info.dat'))));
    const song = BSM.findFile(files, info.songFile); if (!song) { console.log('no audio', z); continue; }
    const pcm = decode(song);
    const an = BSM.analyzeAudio(pcm, 44100);
    const anH = BSM.analyzeAudio(pcm, 44100, { bpmHint: info.bpm });
    console.log('  drift', JSON.stringify(anH.drift));
    console.log(path.basename(z).slice(0, 40), 'map bpm', info.bpm, 'auto', an.bpm.toFixed(3), 'hinted', anH.bpm.toFixed(3), 'conf', an.tempoConfidence.toFixed(2));
    // use hardest standard difficulty
    const d = info.difficulties.filter(x => x.characteristic === 'Standard').pop() || info.difficulties[0];
    const map = BSM.parseDifficulty(JSON.parse(BSM.bytesToText(BSM.findFile(files, d.file))));
    const P = 60 / info.bpm;
    const times = map.notes.map(n => n.time * P);
    // grid error vs the map's own grid: our beat lattice at note times
    let ge = []; for (const t of times) { const k = Math.round((t - anH.phase) / anH.period); ge.push(anH.phase + k * anH.period - t); }
    ge.sort((a, b) => a - b); console.log('  grid-vs-map offset ms: median', (ge[ge.length >> 1] * 1000).toFixed(1), 'p10', (ge[Math.floor(ge.length * .1)] * 1000).toFixed(1), 'p90', (ge[Math.floor(ge.length * .9)] * 1000).toFixed(1));
    // late-vs-early drift: median offset in 4 quarters of the song
    const q = [0, 1, 2, 3].map(i => { const a = ge.length; return null; });
    const qs = [0, 1, 2, 3].map(i => { const lo = i * an.duration / 4, hi = (i + 1) * an.duration / 4; const v = []; for (const t of times) if (t >= lo && t < hi) { const k = Math.round((t - anH.phase) / anH.period); v.push(anH.phase + k * anH.period - t); } v.sort((a, b) => a - b); return v.length ? (v[v.length >> 1] * 1000).toFixed(1) : 'na'; });
    console.log('  per-quarter grid offset ms', qs.join(' / '));
    // onset recall of map notes (unique times), by local gap
    const uniq = [...new Set(times.map(t => Math.round(t * 1000)))].map(x => x / 1000).sort((a, b) => a - b);
    const ts = anH.onsetTimes; const rec = { all: [0, 0], fast: [0, 0] }; const offs = [];
    uniq.forEach((t, i) => {
      const gap = Math.min(i ? t - uniq[i - 1] : 9, i + 1 < uniq.length ? uniq[i + 1] - t : 9);
      let best = 9; for (const x of ts) { const dd = x - t; if (Math.abs(dd) < Math.abs(best)) best = dd; }
      const ok = Math.abs(best) < 0.04; rec.all[1]++; if (ok) { rec.all[0]++; offs.push(best); }
      if (gap < 0.16) { rec.fast[1]++; if (ok) rec.fast[0]++; }
    });
    offs.sort((a, b) => a - b);
    console.log('  onset recall all', (100 * rec.all[0] / rec.all[1]).toFixed(0) + '%', 'fast(<160ms gaps)', (100 * rec.fast[0] / Math.max(1, rec.fast[1])).toFixed(0) + '% of', rec.fast[1], ' median onset-vs-note ms', (offs[offs.length >> 1] * 1000).toFixed(1), ' onsets', ts.length, 'notes', uniq.length);
  }
})();
