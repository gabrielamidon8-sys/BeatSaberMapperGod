// Gameplay study: measures a map (reference or generated) so styles can be compared side by side.
// Exposed as a module (studyMap) and as a CLI:  node test/study.js <label=dir/file.dat@bpm@pcm.f32> ...
const fs = require('fs');
const { loadCore } = require('./lib.js');

const UPISH = new Set([0, 4, 5]), DOWNISH = new Set([1, 6, 7]);

function pct(x, n) { return (n ? 100 * x / n : 0).toFixed(1) + '%'; }

// map: internal map; bpm: the map's own beats-per-minute; an: audio analysis of its song
function studyMap(BSM, map, bpm, an) {
  const sec = b => b * 60 / bpm;
  const notes = map.notes.slice().sort((a, b) => a.time - b.time);
  const out = {};
  const dur = notes.length ? sec(notes[notes.length - 1].time) - sec(notes[0].time) : 1;
  out.notes = notes.length;
  out.nps = notes.length / Math.max(1, dur);

  // hit times (union of both hands), spacing in beats
  const times = [];
  for (const n of notes) if (!times.length || n.time - times[times.length - 1] > 1e-4) times.push(n.time);
  const sp = { le8: 0, q: 0, e3: 0, h: 0, b: 0, long: 0 };
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d <= 0.14) sp.le8++; else if (d <= 0.28) sp.q++; else if (d <= 0.36) sp.e3++; else if (d <= 0.55) sp.h++; else if (d <= 1.05) sp.b++; else sp.long++;
  }
  const tot = Math.max(1, times.length - 1);
  out.spacing = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, +(100 * v / tot).toFixed(1)]));

  // streams: runs of >= 4 hits each <= 0.26 beats after the previous
  let run = 1, streamNotes = 0, runs = 0, longest = 0;
  const flush = () => { if (run >= 4) { runs++; streamNotes += run; longest = Math.max(longest, run); } run = 1; };
  for (let i = 1; i < times.length; i++) { if (times[i] - times[i - 1] <= 0.26) run++; else flush(); }
  flush();
  out.stream = { runs, shareOfHits: +(100 * streamNotes / Math.max(1, times.length)).toFixed(1), longest };

  // chords (both hands same beat) and hand balance
  let chords = 0;
  for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i].time - notes[i - 1].time) < 1e-4) chords++;
  out.chordPct = +(100 * chords / Math.max(1, times.length)).toFixed(1);
  out.redPct = +(100 * notes.filter(n => n.color === 0).length / Math.max(1, notes.length)).toFixed(1);
  out.dotPct = +(100 * notes.filter(n => n.dir === 8).length / Math.max(1, notes.length)).toFixed(1);

  // swing parity: same hand, consecutive, within a beat: a vertical swing should alternate up / down
  let par = 0, parBreak = 0, same = 0, sameCell = 0, sameDir = 0;
  for (const c of [0, 1]) {
    const l = notes.filter(n => n.color === c);
    for (let i = 1; i < l.length; i++) {
      const dt = l[i].time - l[i - 1].time;
      if (dt > 1.05) continue;
      const slide = dt < 0.2;
      same++;
      if (l[i].dir === l[i - 1].dir && l[i].dir !== 8) sameDir++;
      if (l[i].lane === l[i - 1].lane && l[i].layer === l[i - 1].layer) sameCell++;
      const a = l[i - 1].dir, b = l[i].dir;
      const va = UPISH.has(a) ? 1 : DOWNISH.has(a) ? -1 : 0, vb = UPISH.has(b) ? 1 : DOWNISH.has(b) ? -1 : 0;
      if (va && vb && !slide) { par++; if (va === vb) parBreak++; }
    }
  }
  out.parityBreakPct = +(100 * parBreak / Math.max(1, par)).toFixed(1);
  out.sameDirPct = +(100 * sameDir / Math.max(1, same)).toFixed(1);
  out.sameCellPct = +(100 * sameCell / Math.max(1, same)).toFixed(1);

  // direction entropy and cell use
  const dirs = new Array(9).fill(0);
  for (const n of notes) dirs[n.dir]++;
  let ent = 0;
  for (const c of dirs) if (c) { const p = c / notes.length; ent -= p * Math.log(p); }
  out.dirEntropy = +(ent / Math.log(9)).toFixed(3);
  out.dirMix = dirs.map(c => +(100 * c / Math.max(1, notes.length)).toFixed(0));
  const rows = [0, 0, 0];
  for (const n of notes) if (n.layer >= 0 && n.layer < 3) rows[n.layer]++;
  out.rowMix = rows.map(c => +(100 * c / Math.max(1, notes.length)).toFixed(0));

  // does the map follow the music? (needs an)
  if (an) {
    let near = 0;
    for (const t of times) if (BSM.onsetAt(an, sec(t), 0.03) > 0.35) near++;
    out.onOnsetPct = +(100 * near / Math.max(1, times.length)).toFixed(1);
    // correlation between hits per beat and beat energy
    const K = an.beatCount, per = new Array(K).fill(0);
    for (const t of times) {
      const k = Math.floor((sec(t) - an.phase) / an.period);
      if (k >= 0 && k < K) per[k]++;
    }
    const xs = [], ys = [];
    for (let k = 0; k < K; k++) { xs.push(an.beatEnergy[k]); ys.push(per[k]); }
    const mx = xs.reduce((a, b) => a + b, 0) / K, my = ys.reduce((a, b) => a + b, 0) / K;
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < K; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
    out.energyCorr = +(sxy / Math.sqrt(sxx * syy + 1e-9)).toFixed(3);
  }

  // repeated music -> repeated choreography: share of notes (in bars that sound like an earlier bar) that copy it exactly
  if (an && an.study) {
    const st = an.study, bars = new Map();
    for (const n of notes) {
      const q = (sec(n.time) - an.phase) / an.period - st.firstBeat;
      if (q < 0) continue;
      const j = Math.floor(q / 4 + 1e-6);
      if (j >= st.bars) continue;
      if (!bars.has(j)) bars.set(j, new Map());
      bars.get(j).set(Math.round((q - 4 * j) * 12) + '|' + n.color, n);
    }
    let tot = 0, ex = 0;
    bars.forEach((m, j) => {
      const pj = st.partner[j];
      if (pj < 0 || !bars.has(pj)) return;
      m.forEach((n, key) => { tot++; const o = bars.get(pj).get(key); if (o && o.lane === n.lane && o.layer === n.layer && o.dir === n.dir) ex++; });
    });
    out.repeatExactPct = +(100 * ex / Math.max(1, tot)).toFixed(1);
    out.repeatNotes = tot;
  }

  // walls and bombs
  const art = map.walls.filter(w => BSM.isArtWall(w)).length;
  out.walls = map.walls.length - art;
  out.artWalls = art;
  out.bombs = map.bombs.length;
  out.wallsPerMin = +((map.walls.length - art) / Math.max(1, dur) * 60).toFixed(1);
  return out;
}

module.exports = { studyMap };

if (require.main === module) {
  const BSM = loadCore();
  const path = require('path');
  for (const arg of process.argv.slice(2)) {
    // label=file@bpm@pcm
    const [label, rest] = arg.split('=');
    const [file, bpm, pcm] = rest.split('@');
    const map = BSM.parseDifficulty(JSON.parse(fs.readFileSync(file, 'utf8')));
    let an = null;
    if (pcm) {
      const buf = fs.readFileSync(pcm);
      an = BSM.analyzeAudio(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4), 44100);
    }
    const r = studyMap(BSM, map, parseFloat(bpm), an);
    console.log('== ' + label + (an ? '  (detected ' + an.bpm.toFixed(2) + ' BPM vs map ' + bpm + ')' : ''));
    console.log(JSON.stringify(r));
  }
}
