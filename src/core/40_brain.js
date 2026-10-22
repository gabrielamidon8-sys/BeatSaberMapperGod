/* The "brain": statistics learned from existing Beat Saber maps (version 2).
 * Every count is additive, so ingesting more maps only sharpens the priors.
 *
 * Key rule: when the song's audio is available, every time is converted onto the SONG'S OWN beat grid
 * (the detected tempo and phase) before it is counted. A map that says "120 BPM" over music whose pulse
 * is 150 would otherwise teach the rhythm grammar slots that do not line up with the music.
 *
 * Learned pieces
 *   gameplay:  same-hand cut-direction flow (by how fast the hand moves), where the hand goes next,
 *              rhythm slots, gaps between hits, chord rate, stream use (by how busy the music is),
 *              notes per detected onset (so density scales with the song), density by loudness
 *   obstacles: gameplay walls (width, length, rate) kept apart from decorative wall art outside the lanes
 *   bombs:     rate by loudness and per minute
 *   lights:    classic v2 event usage, and a library of v4 light "bars" (see 36_lights4.js)
 */
(function (ns) {
  'use strict';

  const EB = 10; // energy buckets
  const DIFFS = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
  const GAP_EDGES = [0.14, 0.28, 0.36, 0.55, 0.7, 1.05, 1.55, 2.1]; // upper edges (beats); bucket 8 = longer
  const DT_EDGES = [0.3, 0.75];                                    // flow buckets: fast, medium, slow (beats)

  function zeros(n) { return new Array(n).fill(0); }
  function zeros2(r, c) { const a = []; for (let i = 0; i < r; i++) a.push(zeros(c)); return a; }
  function perDiff(make) { const o = {}; for (const d of DIFFS) o[d] = make(); return o; }

  function emptyBrain() {
    return {
      format: 'bsm-brain',
      version: 2,
      sources: [],
      // gameplay
      dirTrans: zeros2(9, 9),
      dirTransB: [zeros2(9, 9), zeros2(9, 9), zeros2(9, 9)],
      dirCount: zeros(9),
      cellCount: zeros2(3, 4),
      moveDelta: [zeros2(7, 5), zeros2(7, 5), zeros2(7, 5)],
      rhythm24: zeros(24),
      gapByDiff: perDiff(function () { return zeros(9); }),
      chordHits: perDiff(function () { return [0, 0]; }),     // [hits with both hands, hits]
      npo: perDiff(function () { return [0, 0]; }),           // [notes, detected onsets in the map's span]
      streamOn: perDiff(function () { return zeros2(5, 2); }), // by onsets in the beat: [stream beats, beats]
      densNotes: zeros(EB), densBeats: zeros(EB),
      chordBeats: zeros(EB), chordCount: zeros(EB),
      // bombs
      bombNotes: zeros(EB), bombBeats: zeros(EB),
      bombMin: perDiff(function () { return [0, 0]; }),        // [bombs, seconds]
      // gameplay walls
      wallType: [0, 0],
      wallWidth: zeros(5),
      wallDur: zeros(7),
      wallMin: perDiff(function () { return [0, 0]; }),
      // wall art (decorative walls outside the lanes)
      art: { walls: 0, byEnergy: zeros2(EB, 2), dur: {}, rows: {}, grid8: zeros(8), dist: zeros(9), paired: [0, 0] },
      // lights
      lightCount: zeros2(5, 13),
      lightLib: { bars: [], init: [], maps: 0, tab: { f: [], x: { 1: [], 2: [], 3: [], 4: [] }, v: { 1: [], 2: [], 3: [], 4: [] } } },
      // instruments: what the note under each kind of attack looks like (counts of direction / row / lane)
      dspv: 2,
      inst: {
        kick: { n: 0, dir: zeros(9), layer: zeros(3), lane: zeros(4) },
        snare: { n: 0, dir: zeros(9), layer: zeros(3), lane: zeros(4) },
        hat: { n: 0, dir: zeros(9), layer: zeros(3), lane: zeros(4) },
        lead: { n: 0, dir: zeros(9), layer: zeros(3), lane: zeros(4) },
        none: { n: 0, dir: zeros(9), layer: zeros(3), lane: zeros(4) },
        pitchLane: zeros2(3, 4)                                // lead pitch third (low, mid, high) -> lane
      },
      // repeated music, repeated choreography: notes in a bar that sounds like an earlier bar
      rep: { total: 0, found: 0, exact: 0, sameHand: 0 },
      // legacy notes-per-second (used when a song has no usable onset rate)
      npb: { Easy: [0, 0], Normal: [0, 0], Hard: [0, 0], Expert: [0, 0], ExpertPlus: [0, 0] }
    };
  }
  ns.emptyBrain = emptyBrain;

  function energyBucket(e) { return ns.clamp(Math.floor(e * EB), 0, EB - 1); }
  function gapBucket(g) { for (let i = 0; i < GAP_EDGES.length; i++) if (g <= GAP_EDGES[i]) return i; return GAP_EDGES.length; }
  function dtBucket(dt) { return dt <= DT_EDGES[0] ? 0 : (dt <= DT_EDGES[1] ? 1 : 2); }
  function durBucket(d) {
    if (d <= 0.5) return 0; if (d <= 1) return 1; if (d <= 2) return 2;
    if (d <= 4) return 3; if (d <= 8) return 4; if (d <= 16) return 5; return 6;
  }
  ns.gapBucket = gapBucket;
  ns.dtBucket = dtBucket;

  function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }

  /* Learn from one difficulty. map = parsed internal map; meta = { name, difficulty, bpm }.
   * analysis (optional) = audio analysis of the same song; it enables the song-aware statistics. */
  function learnFromMap(brain, map, meta, analysis) {
    normalizeBrain(brain);
    const bpm = meta.bpm || 120;
    const spb = 60 / bpm;                                   // seconds per map beat
    const an = analysis || null;
    // map beats -> detected beats (position) and map beats -> detected beats (distance)
    const toB = an ? function (t) { return (t * spb - an.phase) / an.period; } : function (t) { return t; };
    const dB = an ? function (d) { return d * spb / an.period; } : function (d) { return d; };
    const diff = DIFFS.indexOf(meta.difficulty) >= 0 ? meta.difficulty : null;

    const notes = map.notes.slice().sort(function (a, b) { return a.time - b.time; });
    brain.sources.push({ name: meta.name || 'map', difficulty: meta.difficulty, notes: notes.length, bpm: bpm, withAudio: !!an });
    if (!notes.length) return brain;

    const firstT = notes[0].time, lastT = notes[notes.length - 1].time;
    const seconds = Math.max(1, (lastT - firstT) * spb);

    // ----- hits (a hit = one moment with one or two notes) -----
    const hitT = [];
    for (const n of notes) if (!hitT.length || n.time - hitT[hitT.length - 1] > 1e-4) hitT.push(n.time);
    const hitB = hitT.map(toB);
    let chordHits = 0;
    for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i].time - notes[i - 1].time) < 1e-4) chordHits++;

    for (let i = 0; i < hitB.length; i++) {
      const slot = ((Math.round((hitB[i] - Math.floor(hitB[i])) * 24) % 24) + 24) % 24;
      brain.rhythm24[slot]++;
      if (i > 0 && diff) brain.gapByDiff[diff][gapBucket(hitB[i] - hitB[i - 1])]++;
    }
    if (diff) {
      brain.chordHits[diff][0] += chordHits;
      brain.chordHits[diff][1] += hitT.length;
    }

    // ----- streams: runs of at least 4 hits, each within 0.28 beats of the last -----
    const inStream = new Array(hitB.length).fill(false);
    let runStart = 0;
    for (let i = 1; i <= hitB.length; i++) {
      const cont = i < hitB.length && hitB[i] - hitB[i - 1] <= 0.28;
      if (!cont) {
        if (i - runStart >= 4) for (let j = runStart; j < i; j++) inStream[j] = true;
        runStart = i;
      }
    }

    // ----- same-hand flow -----
    for (const color of [0, 1]) {
      const list = notes.filter(function (n) { return n.color === color; });
      for (let i = 0; i < list.length; i++) {
        const d = list[i].dir;
        if (d < 0 || d > 8) continue;
        brain.dirCount[d]++;
        if (list[i].layer >= 0 && list[i].layer < 3 && list[i].lane >= 0 && list[i].lane < 4) brain.cellCount[list[i].layer][list[i].lane]++;
        if (i > 0) {
          const pd = list[i - 1].dir;
          const dt = dB(list[i].time - list[i - 1].time);
          if (pd >= 0 && pd <= 8 && dt < 2.1) {
            brain.dirTrans[pd][d]++;
            const b = dtBucket(dt);
            brain.dirTransB[b][pd][d]++;
            const dx = list[i].lane - list[i - 1].lane, dy = list[i].layer - list[i - 1].layer;
            if (dx >= -3 && dx <= 3 && dy >= -2 && dy <= 2) brain.moveDelta[b][dx + 3][dy + 2]++;
          }
        }
      }
    }

    // ----- gameplay walls vs wall art -----
    const play = [], art = [];
    for (const w of map.walls) (ns.isArtWall(w) ? art : play).push(w);
    for (const w of play) {
      brain.wallType[w.type === 1 ? 1 : 0]++;
      brain.wallWidth[ns.clamp(Math.round(w.width), 1, 4)]++;
      brain.wallDur[durBucket(dB(w.dur))]++;
    }
    if (diff) { brain.wallMin[diff][0] += play.length; brain.wallMin[diff][1] += seconds; }

    for (const e of map.events) {
      if (e.type >= 0 && e.type <= 4 && e.value >= 0 && e.value <= 12) brain.lightCount[e.type][e.value]++;
    }

    if (brain.npb[meta.difficulty]) {
      brain.npb[meta.difficulty][0] += notes.length;
      brain.npb[meta.difficulty][1] += seconds;
    }
    if (diff) { brain.bombMin[diff][0] += map.bombs.length; brain.bombMin[diff][1] += seconds; }

    // ----- everything below needs the song -----
    if (!an) return brain;

    // notes per detected onset
    if (diff && an.onsetTimes) {
      const t0 = firstT * spb, t1 = lastT * spb;
      let peaks = 0;
      for (let i = 0; i < an.onsetTimes.length; i++) if (an.onsetTimes[i] >= t0 && an.onsetTimes[i] <= t1) peaks++;
      if (peaks > 0) { brain.npo[diff][0] += notes.length; brain.npo[diff][1] += peaks; }
    }

    const K = an.beatCount;
    const perBeatNotes = new Array(K).fill(0), perBeatChord = new Array(K).fill(0), perBeatBomb = new Array(K).fill(0);
    const streamHitsInBeat = new Array(K).fill(0);
    const kOf = function (mapBeat) { return Math.floor(toB(mapBeat)); };
    for (const n of notes) { const k = kOf(n.time); if (k >= 0 && k < K) perBeatNotes[k]++; }
    for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i].time - notes[i - 1].time) < 1e-4) { const k = kOf(notes[i].time); if (k >= 0 && k < K) perBeatChord[k] = 1; }
    for (const b of map.bombs) { const k = kOf(b.time); if (k >= 0 && k < K) perBeatBomb[k]++; }
    for (let i = 0; i < hitB.length; i++) if (inStream[i]) { const k = Math.floor(hitB[i]); if (k >= 0 && k < K) streamHitsInBeat[k]++; }

    const kLast = Math.min(K - 1, Math.floor(toB(lastT)));
    const kFirst = Math.max(0, Math.floor(toB(firstT)));
    for (let k = 0; k <= kLast; k++) {
      const eb = energyBucket(an.beatEnergy[k]);
      brain.densBeats[eb]++; brain.densNotes[eb] += perBeatNotes[k];
      brain.chordBeats[eb]++; brain.chordCount[eb] += perBeatChord[k];
      brain.bombBeats[eb]++; brain.bombNotes[eb] += perBeatBomb[k];
    }
    // stream beat = at least 3 stream hits inside it, learned against how many onsets the beat holds
    if (diff && an.onsetTimes) {
      const onPer = new Array(K).fill(0);
      for (let i = 0; i < an.onsetTimes.length; i++) {
        const k = Math.floor((an.onsetTimes[i] - an.phase) / an.period);
        if (k >= 0 && k < K) onPer[k]++;
      }
      for (let k = kFirst; k <= kLast; k++) {
        const b = Math.min(4, onPer[k]);
        brain.streamOn[diff][b][1]++;
        if (streamHitsInBeat[k] >= 3) brain.streamOn[diff][b][0]++;
      }
    }

    // ----- instruments and repeated bars -----
    if (an.instEnv && an.study) {
      const I = brain.inst;
      for (const n of notes) {
        if (n.dir < 0 || n.dir > 8 || n.layer < 0 || n.layer > 2 || n.lane < 0 || n.lane > 3) continue;
        const t = an.phase + toB(n.time) * an.period;
        const r = ns.instAt(an, t, 0.03);
        const name = ns.dominantInst(r) || 'none';
        const rec = I[name];
        rec.n++; rec.dir[n.dir]++; rec.layer[n.layer]++; rec.lane[n.lane]++;
        if (name === 'lead') I.pitchLane[Math.min(2, Math.floor(r.pitch * 3))][n.lane]++;
      }
      const st = an.study, bars = new Map();
      for (const n of notes) {
        const q = toB(n.time) - st.firstBeat;
        if (q < 0) continue;
        const j = Math.floor(q / 4 + 1e-6);
        if (j >= st.bars) continue;
        if (!bars.has(j)) bars.set(j, new Map());
        bars.get(j).set(Math.round((q - 4 * j) * 12) + '|' + n.color, n);
      }
      bars.forEach(function (m, j) {
        const pj = st.partner[j];
        if (pj < 0 || !bars.has(pj)) return;
        const pm = bars.get(pj);
        m.forEach(function (n, key) {
          brain.rep.total++;
          const o = pm.get(key);
          if (o) {
            brain.rep.found++;
            if (o.lane === n.lane && o.layer === n.layer && o.dir === n.dir) brain.rep.exact++;
          } else {
            const other = pm.get(key.split('|')[0] + '|' + (1 - n.color));
            if (other) brain.rep.sameHand++;
          }
        });
      });
    }

    // wall art
    if (art.length) {
      const A = brain.art;
      A.walls += art.length;
      for (let k = kFirst; k <= kLast; k++) A.byEnergy[energyBucket(an.beatEnergy[k])][1]++;
      const times = art.map(function (w) { return w.time; });
      for (const w of art) {
        const k = kOf(w.time);
        if (k >= 0 && k < K) A.byEnergy[energyBucket(an.beatEnergy[k])][0]++;
        const frac = toB(w.time) - Math.floor(toB(w.time));
        A.grid8[Math.round(frac * 8) % 8]++;
        const centre = w.lane + (w.width - 1) / 2;                   // lane centre, grid is 0..3
        const dist = centre < 1.5 ? 1.5 - centre : centre - 1.5;
        A.dist[ns.clamp(Math.floor(dist), 0, 8)]++;
        bump(A.rows, (w.y === undefined ? 0 : w.y) + '|' + (w.h === undefined ? 1 : w.h));
        bump(A.dur, String(Math.round(dB(w.dur) * 1000) / 1000));
        // mirrored partner at the same moment?
        const mirror = 4 - w.lane - w.width;
        A.paired[1]++;
        for (let j = 0; j < art.length; j++) {
          if (art[j] !== w && Math.abs(times[j] - w.time) < 1e-3 && art[j].lane === mirror) { A.paired[0]++; break; }
        }
      }
    }
    return brain;
  }

  // Add any field an older or hand-edited brain does not have (deep, objects only).
  function fill(base, obj) {
    for (const key of Object.keys(base)) {
      if (obj[key] === undefined) obj[key] = JSON.parse(JSON.stringify(base[key]));
      else if (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) && obj[key] && typeof obj[key] === 'object') {
        if (key !== 'rows' && key !== 'dur') fill(base[key], obj[key]);
      }
    }
  }
  function normalizeBrain(b) {
    const base = emptyBrain();
    if (!b || b.format !== 'bsm-brain') return base;
    fill(base, b);
    b.version = 2;
    return b;
  }
  ns.normalizeBrain = normalizeBrain;

  // Turn raw counts into the probabilities and rates the generator samples from.
  function priors(brain) {
    const b = normalizeBrain(brain);
    const sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
    const dirTotal = sum(b.dirCount) + 9;

    // Direction flow. The speed-specific table backs off to the overall table until it has seen enough.
    const markovAll = function (prev, next) {
      if (prev < 0 || prev > 8) return (b.dirCount[next] + 1) / dirTotal;
      const row = b.dirTrans[prev];
      return (row[next] + 0.5 + 0.5 * (b.dirCount[next] + 1) / dirTotal) / (sum(row) + 4.5 + 0.5);
    };
    const markov = function (prev, next, dtBeats) {
      const base = markovAll(prev, next);
      if (prev < 0 || prev > 8 || dtBeats === undefined) return base;
      const row = b.dirTransB[dtBucket(dtBeats)][prev];
      const n = sum(row), K = 4;
      return (row[next] + K * base) / (n + K);
    };
    // Where the hand goes next: log-probability of a (dx, dy) move at this speed, relative to a uniform move.
    const moveW = function (dtBeats, dx, dy) {
      const t = b.moveDelta[dtBucket(dtBeats)];
      let n = 0;
      for (let i = 0; i < 7; i++) n += sum(t[i]);
      if (n < 60) return 0;
      const i = ns.clamp(dx + 3, 0, 6), j = ns.clamp(dy + 2, 0, 4);
      return Math.log(((t[i][j] + 0.5) / (n + 17.5)) * 35);
    };

    const rhythmSum = sum(b.rhythm24);
    const rhythmW = function (idx) {
      if (rhythmSum < 24) return 1;
      return (b.rhythm24[((idx % 24) + 24) % 24] + 1) / (rhythmSum / 24 + 1);
    };
    // how likely a gap of g beats is, relative to an even spread over the buckets
    const gapW = function (diff, g) {
      const row = b.gapByDiff[diff];
      const all = row ? sum(row) : 0;
      if (!row || all < 60) return 1;
      const i = gapBucket(g);
      return ((row[i] + 1) / (all + 9)) * 9;
    };

    // density (notes per beat) as a function of loudness, normalised so the average is 1
    const densTotalN = sum(b.densNotes), densTotalB = sum(b.densBeats);
    const overall = densTotalB > 0 ? densTotalN / densTotalB : 0;
    const densRatio = [];
    for (let i = 0; i < EB; i++) {
      const bb = b.densBeats[i];
      densRatio.push(bb >= 8 && overall > 0 ? ((b.densNotes[i] + 0.5) / (bb + 0.5)) / overall : null);
    }
    const densityMul = function (e) {
      const fallback = 0.35 + 1.3 * e;
      if (overall <= 0) return fallback;
      const x = ns.clamp(e * EB - 0.5, 0, EB - 1);
      const i0 = Math.floor(x), i1 = Math.min(EB - 1, i0 + 1), f = x - i0;
      const r0 = densRatio[i0], r1 = densRatio[i1];
      if (r0 === null && r1 === null) return fallback;
      const v0 = r0 === null ? r1 : r0;
      const v1 = r1 === null ? v0 : r1;
      return v0 * (1 - f) + v1 * f;
    };

    const chordPerHit = function (diff) {
      const v = b.chordHits[diff];
      return v && v[1] >= 80 ? (v[0] + 1) / (v[1] + 12) : null;
    };
    const npoFor = function (diff) {
      const v = b.npo[diff];
      return v && v[0] >= 200 && v[1] > 0 ? v[0] / v[1] : null;
    };
    // probability that a beat holding n onsets is played as a stream
    const streamP = function (diff, n) {
      const v = b.streamOn[diff] && b.streamOn[diff][Math.min(4, n)];
      return v && v[1] >= 25 ? (v[0] + 0.1) / (v[1] + 1) : null;
    };
    const bombRate = function (e) {
      const i = energyBucket(e);
      const bb = b.bombBeats[i];
      if (bb < 8) return null;
      return (b.bombNotes[i] + 0.2) / (bb + 4);
    };
    const perMin = function (table, diff) {
      const v = table[diff];
      return v && v[1] >= 60 ? v[0] / v[1] * 60 : null;
    };
    // wall art
    const A = b.art;
    const artEnergyRate = function (e) {
      const i = energyBucket(e);
      const v = A.byEnergy[i];
      return v[1] >= 8 ? (v[0] + 0.1) / (v[1] + 1) : null;     // art walls per beat at this loudness
    };

    // What an instrument's attack tells us about the note: log-ratio of its direction / row / lane distribution to the
    // overall one (null until it has enough notes). Used as a gentle nudge, never an override.
    const instBias = function (name, dir, layer, lane) {
      const rec = b.inst && b.inst[name];
      if (!rec || rec.n < 150) return null;
      const dTot = sum(b.dirCount) + 9;
      const lTot = sum(b.cellCount.map(sum)) + 12;
      let v = 0;
      if (dir >= 0) v += Math.log(((rec.dir[dir] + 1) / (rec.n + 9)) / ((b.dirCount[dir] + 1) / dTot));
      if (layer >= 0) {
        const lay = b.cellCount[layer] ? sum(b.cellCount[layer]) : 0;
        v += Math.log(((rec.layer[layer] + 1) / (rec.n + 3)) / ((lay + 1) / lTot));
      }
      if (lane >= 0) {
        let ln = 0; for (let r = 0; r < 3; r++) ln += b.cellCount[r][lane];
        v += 0.7 * Math.log(((rec.lane[lane] + 1) / (rec.n + 4)) / ((ln + 1) / lTot));
      }
      return ns.clamp(v, -1.5, 1.5);
    };
    // probability the lead's pitch third maps to a lane (null if unlearned)
    const pitchLaneP = function (third, lane) {
      const row = b.inst && b.inst.pitchLane && b.inst.pitchLane[third];
      if (!row) return null;
      const t = sum(row);
      return t >= 80 ? (row[lane] + 1) / (t + 4) : null;
    };
    const repeat = { total: b.rep.total, found: b.rep.found, exact: b.rep.exact };

    return {
      instBias: instBias,
      pitchLaneP: pitchLaneP,
      repeat: repeat,
      markov: markov,
      moveW: moveW,
      rhythmW: rhythmW,
      gapW: gapW,
      densityMul: densityMul,
      chordPerHit: chordPerHit,
      npoFor: npoFor,
      streamP: streamP,
      bombRate: bombRate,
      bombPerMin: function (d) { return perMin(b.bombMin, d); },
      wallPerMin: function (d) { return perMin(b.wallMin, d); },
      wallWidthWeights: b.wallWidth.slice(1),
      wallDurWeights: b.wallDur.slice(),
      wallTypeWeights: b.wallType,
      art: { data: A, energyRate: artEnergyRate, known: A.walls >= 40 },
      cellWeights: b.cellCount,
      lightCount: b.lightCount,
      lightLib: b.lightLib,
      npbFor: function (diff) {
        const v = b.npb[diff];
        return v && v[1] >= 16 && v[0] > 0 ? v[0] / v[1] : null;
      },
      hasDensity: densTotalB > 0,
      overallNpb: overall
    };
  }
  ns.priors = priors;

  // Human-readable summary for the UI.
  function summarize(brain) {
    const b = normalizeBrain(brain);
    const sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
    const notes = b.sources.reduce(function (a, s) { return a + s.notes; }, 0);
    const withAudio = b.sources.filter(function (s) { return s.withAudio; }).length;
    const flow = b.dirTrans.reduce(function (a, r) { return a + sum(r); }, 0);
    const densB = sum(b.densBeats);
    const gameplayWalls = b.wallType[0] + b.wallType[1];
    const lightEvents = b.lightCount.reduce(function (a, r) { return a + sum(r); }, 0);
    return {
      maps: b.sources.length,
      withAudio: withAudio,
      notes: notes,
      swingTransitions: flow,
      beatsWithAudio: densB,
      walls: gameplayWalls,
      artWalls: b.art.walls,
      lightEvents: lightEvents,
      lightBars: b.lightLib.bars.length,
      lightShows: b.lightLib.maps,
      repeatShare: b.rep && b.rep.total ? b.rep.exact / b.rep.total : 0,
      instNotes: b.inst ? ['kick', 'snare', 'hat', 'lead'].reduce(function (a, k) { return a + b.inst[k].n; }, 0) : 0,
      difficulties: DIFFS.filter(function (k) { return b.npo[k][0] > 0 || b.npb[k][1] > 0; })
    };
  }
  ns.summarizeBrain = summarize;
  ns.learnFromMap = learnFromMap;
})(BSM);
