/* Generative mapper (version 2).
 *
 *   1. density: notes per detected onset (learned from maps) times THIS song's onset rate, shaped by loudness
 *   2. rhythm: each beat is either a stream (a run of quarter-beat notes, when the music is busy enough)
 *      or a hand-picked set of grid slots scored by onset strength, learned rhythm grammar and gap shapes
 *   3. flow: every hit becomes a single note or a mirrored double. Each hand keeps swing parity (an up swing
 *      is followed by a down swing), starts its next swing from where the last one ended, and moves the
 *      way the learned maps move at that speed
 *   4. obstacles: gameplay walls at a learned rate, never over a note's lane; wall art outside the lanes
 *   5. bombs in free cells away from the swing path; lights (v2 events, and v4 phrases from the brain)
 *   6. several seeds are generated and a critic keeps the one closest to what real maps do
 */
(function (ns) {
  'use strict';

  const SLOTS = 24; // grid positions per beat

  const SUB = {
    1: [0], 2: [0, 12], 3: [0, 8, 16], 4: [0, 6, 12, 18], 6: [0, 4, 8, 12, 16, 20],
    8: [0, 3, 6, 9, 12, 15, 18, 21]
  };

  // npo:  notes per detected onset when nothing has been learned yet
  // nps:  [floor, cap] notes per second (a song can be sparse or very busy; the map stays playable)
  // minGapSec / minGapBeats: closest two hits may be (the larger of the two applies)
  // stream: 1 = this difficulty may use streams. wpm: gameplay walls per minute when nothing has been learned
  const PROFILE = {
    Easy:       { npo: 0.20, nps: [0.7, 1.8],  chord: 0.00, dot: 0.10, samehand: 0.30, grid: [1, 2],          minGapSec: 0.45,  minGapBeats: 0.5,    stream: 0, bombs: 0.4, walls: 0.6, wpm: 3, crouch: 0.00, lights: 0.5, chaos: 0.10 },
    Normal:     { npo: 0.33, nps: [1.1, 3.0],  chord: 0.02, dot: 0.08, samehand: 0.20, grid: [1, 2],          minGapSec: 0.28,  minGapBeats: 0.5,    stream: 0, bombs: 0.9, walls: 0.9, wpm: 5, crouch: 0.00, lights: 0.7, chaos: 0.12 },
    Hard:       { npo: 0.45, nps: [1.7, 5.0],  chord: 0.05, dot: 0.05, samehand: 0.12, grid: [1, 2, 3],       minGapSec: 0.17,  minGapBeats: 0.333,  stream: 0, bombs: 1.0, walls: 1.1, wpm: 7, crouch: 0.10, lights: 0.9, chaos: 0.15 },
    Expert:     { npo: 0.70, nps: [2.4, 10.5], chord: 0.10, dot: 0.04, samehand: 0.08, grid: [1, 2, 3, 4],    minGapSec: 0.075, minGapBeats: 0.25,   stream: 1, bombs: 1.1, walls: 1.2, wpm: 8, crouch: 0.20, lights: 1.0, chaos: 0.18 },
    ExpertPlus: { npo: 0.85, nps: [3.0, 13],   chord: 0.08, dot: 0.04, samehand: 0.06, grid: [1, 2, 3, 4, 6], minGapSec: 0.07,  minGapBeats: 0.1667, stream: 1, bombs: 1.1, walls: 1.2, wpm: 7, crouch: 0.25, lights: 1.0, chaos: 0.20 }
  };
  ns.PROFILE = PROFILE;
  const MAX_STREAM_NPS = 12.6;
  // chance a beat is a stream, by how many onsets the music has in it, when nothing has been learned
  const STREAM_DEFAULT = [0, 0.02, 0.2, 0.55, 0.85];

  // lighting values (v2): 1-4 red, 5-8 blue, 9-12 white (on, flash, fade, transition)
  const LIGHT = {
    OFF: 0,
    RED: { on: 1, flash: 2, fade: 3, trans: 4 },
    BLUE: { on: 5, flash: 6, fade: 7, trans: 8 },
    WHITE: { on: 9, flash: 10, fade: 11, trans: 12 }
  };
  // v2 lighting groups
  const GROUP = { BACK: 0, RING: 1, LEFT: 2, RIGHT: 3, CENTER: 4 };
  ns.LIGHT = LIGHT;
  ns.GROUP = GROUP;

  const HORIZ = [0, 0, -1, 1, -1, 1, -1, 1, 0];
  const VERT = [1, -1, 0, 0, 1, 1, -1, -1, 0];
  const NEXT_WM = { 4: 5, 5: 7, 7: 6, 6: 4 };
  const MODES = {
    low: ['minimal', 'wave', 'pillar'],
    mid: ['zigzag', 'wave', 'pillar', 'minimal'],
    high: ['zigzag', 'windmill', 'tech', 'wave', 'pillar']
  };
  ns.MODES = MODES;

  function slotWeight(s) {
    if (s === 0) return 1.0;
    if (s === 12) return 0.8;
    if (s === 6 || s === 18) return 0.7;
    if (s === 8 || s === 16) return 0.55;
    if (s % 3 === 0) return 0.5;
    if (s % 4 === 0) return 0.35;
    if (s % 2 === 0) return 0.2;
    return 0.1;
  }

  function gridSlots(grid) {
    const set = new Set([0]);
    for (const k of grid) for (const s of (SUB[k] || [])) set.add(s);
    return Array.from(set).sort(function (a, b) { return a - b; });
  }

  function outward(lane, layer, dir) {
    let s = 0;
    const left = dir === 2 || dir === 4 || dir === 6;
    const right = dir === 3 || dir === 5 || dir === 7;
    const up = dir === 0 || dir === 4 || dir === 5;
    const down = dir === 1 || dir === 6 || dir === 7;
    if (left) s += lane <= 1 ? 1 : -0.5;
    if (right) s += lane >= 2 ? 1 : -0.5;
    if (up) s += layer === 2 ? 0.5 : (layer === 0 ? -0.5 : 0.1);
    if (down) s += layer === 0 ? 0.5 : (layer === 2 ? -0.5 : 0.1);
    return s;
  }

  function modeBonus(mode, H, lane, layer, dir, d, e, rng) {
    const dl = lane - H.lane, dlay = layer - H.layer;
    let b = 0;
    switch (mode) {
      case 'zigzag':
        if (Math.abs(dl) === 1 && Math.abs(dlay) === 1) b += 1.2;
        if (dir >= 4 && dir <= 7) b += 0.8;
        break;
      case 'wave':
        if (dl !== 0 && Math.sign(dl) === HORIZ[dir]) b += 1.5;
        if (dl === 0) b -= 0.4;
        break;
      case 'pillar':
        if (dl === 0 && dlay !== 0) b += 1.5;
        if (dlay > 0 && VERT[dir] > 0) b += 0.8;
        if (dlay < 0 && VERT[dir] < 0) b += 0.8;
        break;
      case 'windmill':
        if (NEXT_WM[H.dir] === dir) b += 2.0;
        if (lane === 1 || lane === 2) b += 0.3;
        break;
      case 'tech':
        if (dir === 8) b += 0.5;
        if (d === 2) b += 0.6;
        b += 0.3 * rng();
        break;
      case 'minimal':
        if (dir === 0 || dir === 1 || dir === 2 || dir === 3) b += 0.8;
        break;
      default: break;
    }
    if (d >= 2) b += 0.4 * e;
    return b;
  }

  // ---------- swing parity ----------
  // H.v / H.h: the direction the hand's last swing ended in (+1 up/right, -1 down/left, 0 none).
  // The next swing has to come back the other way, and a swing up starts low (a swing down starts high).
  function paritySc(H, dir, dt, layer) {
    if (H.beat < -1e8) return 0;
    if (dir === 8) return 0.2;
    const w = dt >= 1.3 ? 0.3 : 1;       // after a pause the hand may reset
    const v = VERT[dir], h = HORIZ[dir];
    let s = 0;
    if (H.v !== 0) {
      if (v !== 0) s += (v === H.v ? -6 : 0.6) * w;
      else s -= 0.4 * w;
    } else if (H.h !== 0 && v === 0) {
      s += (h === H.h ? -4 : 0.5) * w;
    }
    if (v !== 0 && dt < 1.3) {
      const dl = layer - H.layer;
      s -= 0.7 * w * Math.max(0, v > 0 ? dl : -dl);
    }
    return s;
  }
  function breaksParity(H, dir, dt) {
    if (H.beat < -1e8 || dir === 8 || dt >= 1.3) return false;
    const v = VERT[dir], h = HORIZ[dir];
    if (H.v !== 0) return v !== 0 && v === H.v;
    return H.h !== 0 && v === 0 && h === H.h;
  }

  // ---------- gameplay walls ----------
  const LEVEL_MUL = { low: 0.25, mid: 1, high: 2 };
  function planWalls(an, cfg, pri, rng) {
    const walls = [];
    if (cfg.walls <= 0) return walls;
    const P = an.period;
    const learned = pri.wallPerMin(cfg.difficulty);
    const wpm = (learned !== null ? learned : cfg.wpm) * cfg.walls;
    let bars = 0, wsum = 0;
    for (const sec of an.sections) {
      const n = Math.max(0, Math.floor((sec.end - sec.start) / 4));
      bars += n; wsum += n * LEVEL_MUL[sec.level];
    }
    const avg = bars ? wsum / bars : 1;
    let lastEnd = -1e9, lastCrouch = -1e9;
    const wWeights = pri.wallWidthWeights.slice(0, 2);
    const wNorm = (wWeights[0] + wWeights[1]) > 0 ? wWeights : [0.6, 0.3];
    const durChoices = [0.5, 1, 2, 4];
    const durWeights = [0.15, 0.35, 0.3, 0.2];
    for (const sec of an.sections) {
      const rate = ns.clamp(wpm / 60 * 4 * P * LEVEL_MUL[sec.level] / avg, 0, 0.4);
      for (let k = sec.start; k < sec.end; k++) {
        if ((((k - an.downbeat) % 4) + 4) % 4 !== 0) continue;
        if (k < 8) continue;
        const bs = (an.phase + k * P) / P;
        if (bs < lastEnd + 1) continue;
        if (!rng.chance(rate)) continue;
        const tSec = an.phase + k * P;
        if (sec.level === 'high' && cfg.crouch > 0 && tSec - lastCrouch >= 3 && rng.chance(cfg.crouch)) {
          const dur = rng.chance(0.5) ? 1 : 2;
          walls.push({ time: bs, lane: 0, type: 1, dur: dur, width: 4 });
          lastCrouch = tSec;
          lastEnd = bs + dur;
          continue;
        }
        const width = 1 + rng.weighted(wNorm); // 1 or 2 lanes wide
        const lane = rng.int(4 - width + 1);
        const dur = durChoices[rng.weighted(durWeights)];
        walls.push({ time: bs, lane: lane, type: 0, dur: dur, width: width });
        lastEnd = bs + dur;
      }
    }
    return walls;
  }

  // ---------- wall art (decorative walls outside the lanes, v4 only) ----------
  function sampleKey(dict, rng, fallback) {
    const keys = Object.keys(dict || {});
    if (!keys.length) return fallback;
    return keys[rng.weighted(keys.map(function (k) { return dict[k]; }))];
  }
  function planWallArt(an, cfg, pri, rng) {
    const out = [];
    if (!(cfg.art > 0) || !pri.art.known) return out;
    const A = pri.art.data;
    const P = an.period;
    const bsOf = function (k) { return (an.phase + k * P) / P; };
    const pairedP = A.paired[1] ? Math.max(0.5, A.paired[0] / A.paired[1]) : 0.9;
    // distances 2..8 steps out from the lane centre (>= 2 keeps the wall off the lanes)
    const distW = A.dist.map(function (c, i) { return i >= 2 ? c + 0.5 : 0; });
    const emit = function (time, dist, dur, row) {
      const parts = row.split('|');
      const y = parseInt(parts[0], 10), h = parseInt(parts[1], 10);
      const xl = 1 - dist, xr = 3 - xl;
      const mk = function (x) { return { time: time, lane: x, type: y >= 2 ? 1 : 0, dur: dur, width: 1, y: y, h: h, art: true }; };
      if (rng.chance(pairedP)) { out.push(mk(xl)); out.push(mk(xr)); }
      else out.push(mk(rng.chance(0.5) ? xl : xr));
    };
    const floorRows = Object.keys(A.rows).filter(function (r) { return r.split('|')[0] === '0'; });
    const tallRows = Object.keys(A.rows).filter(function (r) { return parseInt(r.split('|')[1], 10) >= 2 || r.split('|')[0] !== '0'; });
    const rowsOf = function (list, fb) {
      const d = {}; for (const r of list) d[r] = A.rows[r]; return sampleKey(d, rng, fb);
    };
    // Wall art is a drop flourish, not wallpaper: loudest sections first (drops before plain loud ones),
    // within about 15% of the song (the reference spends 64 of its 478 beats on it).
    const loud = an.sections.filter(function (sec) { return sec.level === 'high'; })
      .sort(function (a, b) { return (b.drop - a.drop) || (b.energy - a.energy); });
    let budget = Math.max(8, 0.15 * cfg.art * an.beatCount);
    for (const sec of loud) {
      if (budget <= 0) break;
      const last = Math.min(sec.end, sec.start + Math.ceil(budget));
      budget -= (last - sec.start);
      for (let k = sec.start; k < last; k++) {
        const bar = (((k - an.downbeat) % 4) + 4) % 4 === 0;
        const half = (((k - an.downbeat) % 2) + 2) % 2 === 0;
        if (!half) continue;
        const bs = bsOf(k);
        const gate = Math.min(1, 0.85 * cfg.art);
        if (rng.chance(gate)) {
          // outward sweep: mirrored bars stepping away from the lanes on the 1/8 or 1/4 grid
          const step = rng.chance(0.55) ? 0.125 : 0.25;
          const d0 = 2 + rng.int(3);
          const n = 3 + rng.int(3);
          for (let i = 0; i < n; i++) {
            const dist = ns.clamp(d0 + i, 2, 8);
            const durKey = parseFloat(sampleKey(A.dur, rng, '0.25'));
            emit(bs + i * step * (bar ? 1 : 2), dist, Math.max(0.049, durKey), rowsOf(floorRows, '0|1'));
          }
        }
        if (bar && tallRows.length && rng.chance(0.7 * cfg.art)) {
          // far pillars that blink on the downbeat
          const dist = 7 + rng.int(2);
          emit(bs, dist, rng.chance(0.5) ? 0.049 : 0.75, rowsOf(tallRows, '2|3'));
        }
      }
    }
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  // ---------- hits (rhythm) ----------
  // Expected notes per beat, shaped by loudness and scaled so the song averages the target rate.
  function planTargets(an, cfg, pri) {
    const K = an.beatCount;
    const per = new Float64Array(K);
    let sum = 0, n = 0;
    for (let k = 0; k < K; k++) {
      const e = an.beatEnergy[k];
      if (e < 0.04) continue;
      per[k] = pri.densityMul(e); sum += per[k]; n++;
    }
    const mean = n ? sum / n : 1;
    let total = 0;
    for (let k = 0; k < K; k++) {
      if (per[k] > 0) { per[k] = cfg.npb * per[k] / mean * cfg.density; total += per[k]; }
    }
    return { perBeat: per, total: total };
  }

  function planHits(an, cfg, pri, rng) {
    const P = an.period, A = an.phase, K = an.beatCount;
    const grid = gridSlots(cfg.grid);
    const targets = cfg.plan || planTargets(an, cfg, pri);
    const hitTotal = targets.total / (1 + cfg.chord);

    const onPer = new Array(K).fill(0);
    if (an.onsetTimes) for (let i = 0; i < an.onsetTimes.length; i++) {
      const k = Math.floor((an.onsetTimes[i] - A) / P);
      if (k >= 0 && k < K) onPer[k]++;
    }
    // onsets that sit on the quarter-beat grid: only these justify a quarter-note stream (triplet-feel music does not)
    const onQ = new Array(K).fill(0);
    if (an.onsetTimes) for (let i = 0; i < an.onsetTimes.length; i++) {
      const f = (an.onsetTimes[i] - A) / P, k = Math.floor(f);
      const q = (f - k) * 4;
      if (k >= 0 && k < K && Math.abs(q - Math.round(q)) < 0.25) onQ[k]++;
    }

    // which beats are streams
    const stream = new Array(K).fill(false);
    if (cfg.stream > 0 && 4 / P <= MAX_STREAM_NPS) {
      let inRun = false;
      for (let k = 0; k < K; k++) {
        const e = an.beatEnergy[k];
        if (e < 0.3) { inRun = false; continue; }
        const n = Math.min(4, onQ[k]);
        let p = pri.streamP(cfg.difficulty, n);
        if (p === null) p = STREAM_DEFAULT[n];
        // a learned stream habit cannot override the music: sparse beats rarely become streams
        if (n <= 1) p = Math.min(p, 0.08); else if (n === 2) p = Math.min(p, 0.4);
        p *= cfg.stream;
        if (inRun && n >= 2) p = Math.min(1, p + 0.3);
        stream[k] = rng() < Math.min(1, p);
        inRun = stream[k];
      }
      for (let k = 0; k < K; k++) {          // one lone stream beat is just four notes: not a stream
        if (stream[k] && !(k > 0 && stream[k - 1]) && !(k + 1 < K && stream[k + 1])) stream[k] = false;
      }
      // never let streams alone overshoot the target; drop the least musical stream beats first
      let S = 0;
      const sb = [];
      for (let k = 0; k < K; k++) if (stream[k]) { S += 4; sb.push(k); }
      if (S > 1.1 * hitTotal) {
        sb.sort(function (a, b) { return (onPer[a] + an.beatEnergy[a]) - (onPer[b] + an.beatEnergy[b]); });
        for (const k of sb) { if (S <= 1.1 * hitTotal) break; stream[k] = false; S -= 4; }
      }
    }
    // A beat holds about as many hits as the music has onsets in it (real maps do this), never many more.
    const hasOnsets = !!an.onsetTimes;
    const capOf = function (k) { return hasOnsets ? onPer[k] + (onPer[k] >= 3 ? 1 : 0.35) : Infinity; };
    let S = 0, R = 0;
    for (let k = 0; k < K; k++) {
      if (targets.perBeat[k] <= 0) continue;
      if (stream[k]) S += 4; else R += Math.min(targets.perBeat[k] / (1 + cfg.chord), capOf(k));
    }
    const scale = R > 0 ? ns.clamp((hitTotal - S) / R, 0.2, 1.8) : 1;

    const hits = [];
    const accepted = [];
    const lastAcc = function () { return accepted.length ? accepted[accepted.length - 1] : -1e9; };
    for (let k = 0; k < K; k++) {
      const e = an.beatEnergy[k];
      const isDown = (((k - an.downbeat) % 4) + 4) % 4 === 0;
      if (e < 0.04 || targets.perBeat[k] <= 0) continue;
      if (stream[k]) {
        for (const s of [0, 6, 12, 18]) {
          const bs = (A + (k + s / SLOTS) * P) / P;
          const strength = ns.onsetAt(an, A + (k + s / SLOTS) * P, 0.025);
          hits.push({ k: k, s: s, bs: bs, strength: strength, e: e, down: isDown && s === 0, stream: true, first: s === 0 && !stream[k - 1] });
          accepted.push(bs);
        }
        continue;
      }
      const target = Math.min(Math.min(targets.perBeat[k] / (1 + cfg.chord), capOf(k)) * scale, capOf(k) + 0.5);
      let m = Math.floor(target);
      if (rng() < target - m) m++;
      if (m <= 0) continue;
      const cands = [];
      for (const s of grid) {
        const t = A + (k + s / SLOTS) * P;
        const strength = ns.onsetAt(an, t, 0.025);
        const bs = t / P;
        const gap = bs - lastAcc();
        // learned habits only nudge: the music (onset strength) and the metrical weight of the slot decide
        const gw = gap < 2.1 ? Math.pow(ns.clamp(pri.gapW(cfg.difficulty, gap), 0.3, 3), 0.35) : 1;
        const rw = Math.pow(ns.clamp(pri.rhythmW(s), 0.15, 6), 0.4);
        const sc = (0.15 + strength) * slotWeight(s) * rw * gw * (0.75 + 0.5 * rng());
        cands.push({ s: s, sc: sc, strength: strength });
      }
      cands.sort(function (a, b) { return b.sc - a.sc; });
      const chosen = [];
      if (isDown && e > 0.25) {
        const first = cands.find(function (c) { return c.s === 0; });
        const bs0 = (A + k * P) / P;
        if (first && bs0 - lastAcc() >= cfg.minGap - 1e-6) { chosen.push(first); accepted.push(bs0); }
      }
      for (const c of cands) {
        if (chosen.length >= m) break;
        if (chosen.indexOf(c) >= 0) continue;
        const bs = (A + (k + c.s / SLOTS) * P) / P;
        let ok = true;
        for (let i = accepted.length - 1; i >= 0 && i >= accepted.length - 40; i--) {
          if (Math.abs(accepted[i] - bs) < cfg.minGap - 1e-6) { ok = false; break; }
        }
        if (!ok) continue;
        chosen.push(c);
        accepted.push(bs);
      }
      for (const c of chosen) {
        hits.push({ k: k, s: c.s, bs: (A + (k + c.s / SLOTS) * P) / P, strength: c.strength, e: e, down: isDown && c.s === 0, stream: false });
      }
    }
    hits.sort(function (a, b) { return a.bs - b.bs; });
    return hits;
  }

  // ---------- one candidate ----------
  function generateOnce(an, cfg, pri, seed) {
    const rng = ns.makeRng(seed);
    const P = an.period;
    const walls = planWalls(an, cfg, pri, rng);
    const hits = planHits(an, cfg, pri, rng);

    const occ = new Set();
    const notes = [];
    const fresh = function (lane, layer) { return { lane: lane, layer: layer, dir: -1, beat: -1e9, v: 0, h: 0 }; };
    const hands = [fresh(1, 1), fresh(2, 1)];
    const blocked = function (bs, lane, layer) {
      for (const w of walls) {
        if (bs < w.time - 0.5 || bs > w.time + w.dur + 0.5) continue;
        if (w.type === 0) { if (lane >= w.lane - 1 && lane <= w.lane + w.width) return true; }
        else if (layer === 2) return true;
      }
      return false;
    };
    const keyOf = function (bs, lane, layer) { return Math.round(bs * 48) + '|' + lane + '|' + layer; };
    const occupied = function (bs, lane, layer) { return occ.has(keyOf(bs, lane, layer)); };
    const dotBonus = Math.log(cfg.dot + 0.001) + 1.2;
    const flow = cfg.flow || 1;

    const chooseCell = function (hand, bs, e, mode) {
      const H = hands[hand], O = hands[1 - hand];
      const dt = bs - H.beat;
      const reach = ns.allowedReach(dt, P);
      const seen = H.beat > -1e8;
      let best = null, bestSc = -Infinity;
      for (let layer = 0; layer < 3; layer++) {
        for (let lane = 0; lane < 4; lane++) {
          if (occupied(bs, lane, layer) || blocked(bs, lane, layer)) continue;
          const d = Math.max(Math.abs(lane - H.lane), Math.abs(layer - H.layer));
          let base = 0;
          if (d > reach) base -= 4 * (d - reach);
          if (d === 0 && dt < 0.5 && seen) base -= 1.5;
          if (O.beat > -1e8 && Math.abs(bs - O.beat) < 0.25 && O.lane === lane && O.layer === layer) base -= 6;
          if (seen && dt < 2.1) base += 0.6 * pri.moveW(dt, lane - H.lane, layer - H.layer);
          for (let dir = 0; dir <= 8; dir++) {
            let sc = base;
            if (dir === 8) sc += dotBonus;
            else {
              sc += flow * Math.log(pri.markov(H.dir, dir, dt));
              sc += 0.6 * outward(lane, layer, dir);
            }
            sc += paritySc(H, dir, dt, layer);
            sc += modeBonus(mode, H, lane, layer, dir, d, e, rng);
            sc += cfg.chaos * 3 * rng.gumbel();
            if (sc > bestSc) { bestSc = sc; best = { lane: lane, layer: layer, dir: dir, reachOk: d <= reach }; }
          }
        }
      }
      return best;
    };

    const place = function (hand, bs, c) {
      notes.push({ time: bs, lane: c.lane, layer: c.layer, color: hand, dir: c.dir });
      occ.add(keyOf(bs, c.lane, c.layer));
      let v = VERT[c.dir], h = HORIZ[c.dir];
      if (c.dir === 8) { v = -hands[hand].v; h = 0; }          // a dot keeps the swing going
      hands[hand] = { lane: c.lane, layer: c.layer, dir: c.dir, beat: bs, v: v, h: h };
    };

    let lastHand = 1;
    let mode = 'zigzag', modeUntil = -1e9;
    let skipped = 0;
    const modeList = [];
    for (const h of hits) {
      if (h.bs >= modeUntil) {
        const list = cfg.style === 'tech' ? ['tech', 'windmill', 'zigzag']
          : cfg.style === 'minimal' ? ['minimal', 'pillar', 'wave']
          : cfg.style === 'flow' ? ['wave', 'zigzag', 'pillar']
          : (MODES[sectionLevel(an, h.k)] || MODES.mid);
        mode = rng.pick(list);
        modeUntil = h.bs + 8 + rng.int(9);
        modeList.push(mode);
      }
      if (h.stream) {
        // streams alternate hands strictly
        const hand = 1 - lastHand;
        let c = chooseCell(hand, h.bs, h.e, mode), useHand = hand;
        if (!c || !c.reachOk) {
          const alt = chooseCell(1 - hand, h.bs, h.e, mode);
          if (alt && alt.reachOk) { c = alt; useHand = 1 - hand; } else { skipped++; continue; }
        }
        place(useHand, h.bs, c);
        lastHand = useHand;
        continue;
      }
      const chordP = ns.clamp(cfg.chord * (0.45 + h.e) * (h.s === 0 ? 1.2 : 0.85) * (0.7 + 0.6 * h.strength), 0, 0.5);
      if (rng() < chordP) {
        const red = chooseCell(0, h.bs, h.e, mode);
        if (!red || !red.reachOk) { skipped++; continue; }
        place(0, h.bs, red);
        let blue = null;
        const mirror = { lane: 3 - red.lane, layer: red.layer, dir: ns.MIRROR_DIR[red.dir] };
        const dtB = h.bs - hands[1].beat;
        const mdist = Math.max(Math.abs(mirror.lane - hands[1].lane), Math.abs(mirror.layer - hands[1].layer));
        if (!occupied(h.bs, mirror.lane, mirror.layer) && !blocked(h.bs, mirror.lane, mirror.layer) &&
            mdist <= ns.allowedReach(dtB, P) && !breaksParity(hands[1], mirror.dir, dtB)) {
          blue = mirror;
        } else {
          blue = chooseCell(1, h.bs, h.e, mode);
          if (blue && !blue.reachOk) blue = null;
        }
        if (blue) place(1, h.bs, blue); else skipped++;
        lastHand = 1;
        continue;
      }
      let hand = 1 - lastHand;
      if (rng() < cfg.samehand && h.bs - hands[lastHand].beat >= 0.5) hand = lastHand;
      let c = chooseCell(hand, h.bs, h.e, mode), useHand = hand;
      if (!c || !c.reachOk) {
        const alt = chooseCell(1 - hand, h.bs, h.e, mode);
        if (alt && alt.reachOk) { c = alt; useHand = 1 - hand; }
        else { skipped++; continue; }
      }
      place(useHand, h.bs, c);
      lastHand = useHand;
    }

    const streamBeats = new Set();
    for (const h of hits) if (h.stream) streamBeats.add(h.k);
    const bombs = planBombs(an, cfg, pri, rng, notes, walls, occupied, blocked, streamBeats);
    const events = cfg.lights ? planLights(an, cfg, pri, rng) : [];
    const art = planWallArt(an, cfg, pri, rng);

    notes.sort(function (a, b) { return a.time - b.time; });
    const allWalls = walls.concat(art).sort(function (a, b) { return a.time - b.time; });
    return {
      map: { notes: notes, bombs: bombs, walls: allWalls, events: events },
      seed: seed,
      hits: hits.length,
      streamHits: hits.filter(function (x) { return x.stream; }).length,
      skipped: skipped,
      modes: modeList
    };
  }

  function sectionLevel(an, k) {
    for (const s of an.sections) if (k >= s.start && k < s.end) return s.level;
    return 'mid';
  }

  function planBombs(an, cfg, pri, rng, notes, walls, occupied, blocked, streamBeats) {
    const bombs = [];
    if (cfg.bombs <= 0) return bombs;
    const P = an.period, A = an.phase, K = an.beatCount;
    const perBeatBase = 4 * P / 60 * cfg.bombs; // fallback: about 4 bombs per minute at multiplier 1
    const sorted = notes.slice().sort(function (a, b) { return a.time - b.time; });
    const nearNotes = function (bs, lane, layer) {
      for (let i = sorted.length - 1; i >= 0; i--) {
        const n = sorted[i];
        if (n.time < bs - 0.5) break;
        if (n.time > bs + 0.5) continue;
        if (Math.max(Math.abs(n.lane - lane), Math.abs(n.layer - layer)) <= 1) return true;
      }
      return false;
    };
    for (let k = 0; k < K; k++) {
      const e = an.beatEnergy[k];
      if (e < 0.08 || streamBeats.has(k) || streamBeats.has(k - 1)) continue;
      const learned = pri.bombRate(e);
      const rate = learned !== null ? learned * cfg.bombs : perBeatBase * (0.4 + e);
      if (!rng.chance(rate)) continue;
      const sOff = rng.pick([6, 12, 18]);
      const bs = (A + (k + sOff / SLOTS) * P) / P;
      const cells = [];
      for (let layer = 0; layer < 3; layer++) for (let lane = 0; lane < 4; lane++) cells.push({ lane: lane, layer: layer });
      for (let i = cells.length - 1; i > 0; i--) { const j = rng.int(i + 1); const t = cells[i]; cells[i] = cells[j]; cells[j] = t; }
      for (const c of cells) {
        if (occupied(bs, c.lane, c.layer) || blocked(bs, c.lane, c.layer)) continue;
        if (nearNotes(bs, c.lane, c.layer)) continue;
        bombs.push({ time: bs, lane: c.lane, layer: c.layer });
        break;
      }
    }
    return bombs;
  }

  function planLights(an, cfg, pri, rng) {
    const ev = [];
    const P = an.period, A = an.phase;
    const bsOf = function (k) { return (A + k * P) / P; };
    const push = function (bs, type, value) { ev.push({ time: bs, type: type, value: value, float: 1 }); };
    const sections = an.sections;
    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      const main = si % 2 === 0 ? LIGHT.BLUE : LIGHT.RED;
      const alt = si % 2 === 0 ? LIGHT.RED : LIGHT.BLUE;
      const startBs = bsOf(sec.start);
      push(startBs, GROUP.CENTER, LIGHT.WHITE.trans);
      push(startBs, GROUP.BACK, main.trans);
      if (sec.drop) {
        push(startBs, GROUP.BACK, LIGHT.WHITE.flash);
        push(startBs, GROUP.RING, LIGHT.WHITE.flash);
      }
      for (let k = sec.start; k < sec.end; k++) {
        const bs = bsOf(k);
        const bar = (((k - an.downbeat) % 4) + 4) % 4 === 0;
        const half = (((k - an.downbeat) % 2) + 2) % 2 === 0;
        const kick = an.beatBass[k] > 0.55;
        if (sec.level === 'low') {
          if (bar && rng.chance(0.5 * cfg.lights)) push(bs, GROUP.RING, main.fade);
        } else if (sec.level === 'mid') {
          if (bar) push(bs, GROUP.RING, (k % 8 === 0 ? main : alt).flash);
          if (kick && rng.chance(0.6 * cfg.lights)) push(bs, GROUP.CENTER, main.flash);
          if (bar && rng.chance(0.4 * cfg.lights)) push(bs, GROUP.LEFT, main.on);
        } else {
          if (half && rng.chance(0.6 * cfg.lights)) push(bs, GROUP.RING, (k % 8 < 4 ? main : alt).flash);
          if (bar) {
            push(bs, GROUP.BACK, alt.flash);
            push(bs, GROUP.LEFT, main.on);
            push(bs, GROUP.RIGHT, alt.on);
          }
          if (kick && half && rng.chance(0.7 * cfg.lights)) push(bs, GROUP.CENTER, alt.flash);
        }
      }
    }
    ev.sort(function (a, b) { return a.time - b.time; });
    return ev;
  }

  // ---------- the critic ----------
  // Score a candidate by what real maps do: playable, in parity, the right amount of notes and doubles,
  // notes on the music's onsets, varied directions, nothing overlapping.
  function critique(res, an, cfg) {
    const map = res.map;
    const v = ns.validateMap(map, an.bpm);
    const notes = map.notes;
    const N = Math.max(1, notes.length);
    const detail = { errors: v.errors.length, reach: v.reachViolations };

    // swing parity per hand
    let par = 0, brk = 0;
    for (const color of [0, 1]) {
      let prev = null;
      for (const n of notes) {
        if (n.color !== color) continue;
        if (prev && n.time - prev.time <= 1.05) {
          const a = VERT[prev.dir], b = VERT[n.dir];
          if (prev.dir !== 8 && n.dir !== 8 && a && b) { par++; if (a === b) brk++; }
        }
        prev = n;
      }
    }
    detail.parityBreak = par ? brk / par : 0;

    // doubles
    let chords = 0, hitsN = 0;
    for (let i = 0; i < notes.length; i++) {
      if (i === 0 || Math.abs(notes[i].time - notes[i - 1].time) > 1e-4) hitsN++;
      else chords++;
    }
    detail.chordRate = hitsN ? chords / hitsN : 0;

    // notes on onsets
    let on = 0, cnt = 0;
    let lastT = -1;
    for (const n of notes) {
      if (n.time === lastT) continue;
      lastT = n.time; cnt++;
      if (ns.onsetAt(an, n.time * an.period, 0.03) > 0.35) on++;
    }
    detail.onOnset = cnt ? on / cnt : 0;

    // direction variety
    const counts = new Array(9).fill(0);
    for (const n of notes) counts[n.dir]++;
    let ent = 0;
    for (const c of counts) if (c > 0) { const p = c / N; ent -= p * Math.log(p); }
    detail.dirEntropy = ent / Math.log(9);

    const expNotes = Math.max(1, res.expectedNotes);
    let score = 0;
    score -= 20 * detail.errors;
    score -= 2.0 * detail.reach;
    score -= 0.5 * v.bombHits;
    score -= 18 * detail.parityBreak;
    score -= 6 * Math.abs(detail.chordRate - cfg.chord);
    score += 3.0 * detail.onOnset;
    score += 1.5 * detail.dirEntropy;
    score -= 2.5 * Math.abs(notes.length - expNotes) / expNotes;
    detail.score = score;
    return detail;
  }

  /* generateMap(analysis, options, brain) -> { map, meta }
   * options: { difficulty, density, chaos, style, lights, bombs, walls, dots, art, streams, candidates, seed } */
  function generateMap(an, options, brain) {
    options = options || {};
    const diff = options.difficulty && PROFILE[options.difficulty] ? options.difficulty : 'Expert';
    const base = PROFILE[diff];
    const pri = ns.priors(brain || ns.emptyBrain());
    const mult = function (x) { return x === undefined ? 1 : x; };

    // density: notes per detected onset (learned) x this song's onset rate, inside the playable range
    const learnedNpo = pri.npoFor(diff);
    let nps;
    if (an.onsetRate > 0) nps = (learnedNpo !== null ? learnedNpo : base.npo) * an.onsetRate;
    else nps = pri.npbFor(diff) || base.nps[0] * 1.5;
    nps = ns.clamp(nps, base.nps[0], base.nps[1]);

    const learnedChord = pri.chordPerHit(diff);
    const style = options.style || 'balanced';
    const cfg = {
      difficulty: diff,
      nps: nps,
      npb: nps * an.period,                                   // notes per beat on THIS song's beat grid
      chord: (learnedChord !== null ? learnedChord : base.chord) * (style === 'tech' ? 1.2 : 1),
      dot: base.dot * mult(options.dots),
      samehand: base.samehand,
      grid: base.grid,
      minGap: Math.max(base.minGapBeats, base.minGapSec / an.period),
      bombs: base.bombs * mult(options.bombs),
      walls: base.walls * mult(options.walls),
      wpm: base.wpm,
      crouch: base.crouch,
      art: mult(options.art),
      stream: base.stream * mult(options.streams) * (style === 'minimal' ? 0 : style === 'flow' ? 0.6 : style === 'tech' ? 1.3 : 1),
      lights: options.lights === false ? false : true,
      lightAmount: options.lightAmount,
      chaos: options.chaos === undefined ? base.chaos : options.chaos,
      density: mult(options.density),
      style: style,
      flow: style === 'flow' ? 1.6 : 1
    };
    if (style === 'chaos') cfg.chaos = Math.max(cfg.chaos, 0.45);
    if (style === 'minimal') { cfg.walls *= 0.4; cfg.bombs *= 0.5; }
    if (style === 'tech') cfg.dot *= 2;
    cfg.plan = planTargets(an, cfg, pri);

    const baseSeed = (options.seed === undefined ? (Date.now() & 0x7fffffff) : options.seed) >>> 0;
    const candidates = Math.max(1, options.candidates || 4);
    let best = null;
    for (let c = 0; c < candidates; c++) {
      const seed = (baseSeed + Math.imul(c + 1, 0x9E3779B1)) >>> 0;
      const res = generateOnce(an, cfg, pri, seed);
      res.expectedNotes = cfg.plan.total * (1 + cfg.chord * 0.5) / (1 + cfg.chord) ;
      res.critic = critique(res, an, cfg);
      res.score = res.critic.score;
      if (!best || res.score > best.score) best = res;
    }
    // v4 lighting: composed once per song and shared by every difficulty that uses the same seed
    if (cfg.lights && options.lights4 !== false) {
      const l4 = ns.planLights4 ? ns.planLights4(an, cfg, brain || ns.emptyBrain(), ns.makeRng((baseSeed ^ 0x5bd1e995) >>> 0)) : null;
      if (l4) best.map.lights4 = l4;
    }
    const stats = ns.mapStats(best.map, an.bpm);
    return {
      map: best.map,
      meta: {
        difficulty: diff,
        bpm: an.bpm,
        seed: best.seed,
        score: best.score,
        critic: best.critic,
        candidates: candidates,
        hits: best.hits,
        streamHits: best.streamHits,
        skipped: best.skipped,
        modes: best.modes.slice(0, 40),
        stats: stats,
        validation: ns.validateMap(best.map, an.bpm),
        config: { nps: cfg.nps, chord: cfg.chord, stream: cfg.stream, minGap: cfg.minGap, style: cfg.style }
      }
    };
  }

  ns.generateMap = generateMap;
  ns.planHits = planHits;
  ns.SLOTS = SLOTS;
})(BSM);
