/* Pattern library: short note sequences ("motifs") the generator can drop into a map.
 *
 * A motif is a list of moments: { m: [[dt, [[colour, lane, layer, dir], ...]], ...] } with dt in beats from the first
 * moment, plus n (times seen), t (technicality 0..1), lo (lowest difficulty index it was seen on).
 *
 * Three sources:
 *   BUILTIN_COMBOS   hand-written one-moment combos from the community's vocabulary (stack, tower, window, invert,
 *                    scissor, wide and split doubles). Used for accents.
 *   BUILTIN_MOTIFS   a few hand-written multi-moment patterns.
 *   mined            every 3-5 moment run found in the maps the brain learns from, mirrored variants merged.
 *
 * Technicality scores what makes a sequence "tech": dots, sideways and diagonal swings, crossovers, jumps of two or more
 * cells, turns that are not simple up/down alternation, and doubles that are not mirror images. */
(function (ns) {
  'use strict';

  const MIRROR = ns.MIRROR_DIR;
  const DIFF_IDX = { Easy: 0, Normal: 1, Hard: 2, Expert: 3, ExpertPlus: 4 };
  const VERT = [1, -1, 0, 0, 1, 1, -1, -1, 0];
  const HORIZ = [0, 0, -1, 1, -1, 1, -1, 1, 0];
  const MAX_MINED = 420;

  function mirrorNote(n) { return [1 - n[0], 3 - n[1], n[2], MIRROR[n[3]]]; }
  function mirrorMotif(m) { return m.map(function (mo) { return [mo[0], mo[1].map(mirrorNote)]; }); }
  function keyOf(m) { return JSON.stringify(m); }
  ns.mirrorMotif = mirrorMotif;

  // how "tech" a motif is, 0..1
  function techScore(m) {
    let pts = 0, cnt = 0;
    const last = [null, null];
    for (const mo of m) {
      const notes = mo[1];
      for (const n of notes) {
        cnt++;
        const c = n[0], lane = n[1], dir = n[3];
        if (dir === 8) pts += 0.7;
        else if (dir === 2 || dir === 3) pts += 0.5;                        // sideways swing
        else if (dir >= 4) pts += 0.3;                                       // diagonal
        if ((c === 0 && lane >= 2) || (c === 1 && lane <= 1)) pts += 0.6;    // crossover
        const p = last[c];
        if (p) {
          const dist = Math.max(Math.abs(p[1] - lane), Math.abs(p[2] - n[2]));
          if (dist >= 2) pts += 0.6;                                         // jump
          if (dir !== 8 && p[3] !== 8) {
            const v1 = VERT[p[3]], v2 = VERT[dir], h1 = HORIZ[p[3]], h2 = HORIZ[dir];
            if (!(v1 && v2 && v1 !== v2 && h1 === h2)) pts += 0.35;          // not a plain up/down alternation
          }
        }
        last[c] = n;
      }
      if (notes.length === 2 && notes[0][0] !== notes[1][0]) {
        const a = notes[0], b = notes[1];
        const mirrored = a[1] + b[1] === 3 && a[2] === b[2] && MIRROR[a[3]] === b[3];
        if (!mirrored) pts += 0.5;
      }
    }
    return ns.clamp(pts / Math.max(1, cnt) / 2.1, 0, 1);
  }
  ns.techScore = techScore;

  // ---- hand-written combos (one moment) ----
  // colour 0 = red (left hand), 1 = blue; dir 0 up, 1 down, 2 left, 3 right, 4 up-left, 5 up-right, 6 down-left, 7 down-right, 8 dot
  const BUILTIN_COMBOS = [
    { name: 'stack',    w: 3,   lo: 2, m: [[0, [[0, 1, 0, 1], [0, 1, 1, 1]]]] },
    { name: 'stack-up', w: 1.5, lo: 2, m: [[0, [[0, 1, 1, 0], [0, 1, 2, 0]]]] },
    { name: 'tower',    w: 2,   lo: 3, m: [[0, [[0, 1, 0, 1], [0, 1, 1, 1], [0, 1, 2, 1]]]] },
    { name: 'window',   w: 2.5, lo: 3, m: [[0, [[0, 1, 0, 1], [0, 1, 2, 1]]]] },
    { name: 'invert',   w: 1.2, lo: 3, m: [[0, [[0, 1, 1, 3], [1, 2, 1, 2]]]] },
    { name: 'scissor',  w: 1.2, lo: 3, m: [[0, [[0, 0, 0, 6], [1, 3, 0, 7]]]] },
    { name: 'wide',     w: 1.5, lo: 2, m: [[0, [[0, 0, 1, 1], [1, 3, 1, 1]]]] },
    { name: 'split',    w: 1.5, lo: 3, m: [[0, [[0, 1, 2, 0], [1, 2, 0, 1]]]] },
    { name: 'tower-pair', w: 0.8, lo: 4, m: [[0, [[0, 1, 0, 1], [0, 1, 1, 1], [0, 1, 2, 1], [1, 2, 0, 1], [1, 2, 1, 1], [1, 2, 2, 1]]]] }
  ];
  // ---- hand-written multi-moment patterns ----
  const BUILTIN_MOTIFS = [
    // the hands answer each other across a gap: red up-left, blue down-right ... then the inverse
    { name: 'cross-answer', lo: 3, m: [[0, [[0, 1, 1, 4]]], [0.5, [[1, 2, 1, 7]]], [1, [[0, 1, 1, 6]]], [1.5, [[1, 2, 1, 5]]]] },
    { name: 'box-red',      lo: 3, m: [[0, [[0, 0, 1, 0]]], [0.5, [[1, 3, 1, 1]]], [1, [[0, 1, 1, 1]]], [1.5, [[1, 2, 1, 0]]]] },
    { name: 'down-up-jump', lo: 3, m: [[0, [[0, 0, 0, 1]]], [0.5, [[1, 3, 0, 1]]], [1, [[0, 0, 2, 0]]], [1.5, [[1, 3, 2, 0]]]] },
    { name: 'inward-roll',  lo: 3, m: [[0, [[0, 1, 1, 3]]], [0.5, [[1, 2, 1, 2]]], [1, [[0, 1, 0, 7]]], [1.5, [[1, 2, 0, 6]]]] },
    // rising two-lane wave: both hands swing down, then up, one row higher each time
    { name: 'wave-four',    lo: 3, m: [[0, [[0, 1, 0, 1]]], [0.5, [[1, 2, 0, 1]]], [1, [[0, 1, 1, 0]]], [1.5, [[1, 2, 1, 0]]]] },
    // double staircase: both hands climb the outer lanes, alternating diagonals
    { name: 'stair-doubles', lo: 3, m: [[0, [[0, 0, 0, 6], [1, 3, 0, 7]]], [0.5, [[0, 0, 1, 4], [1, 3, 1, 5]]], [1, [[0, 0, 2, 6], [1, 3, 2, 7]]]] },
    // a diamond: top pair, then the sides answer
    { name: 'diamond',      lo: 3, m: [[0, [[0, 1, 2, 1]]], [0.5, [[1, 2, 2, 1]]], [1, [[0, 0, 1, 5]]], [1.5, [[1, 3, 1, 4]]]] },
    // slam: doubles at the bottom corners, up to the top corners, then the centre
    { name: 'jump-slam',    lo: 4, m: [[0, [[0, 0, 0, 1], [1, 3, 0, 1]]], [1, [[0, 0, 2, 0], [1, 3, 2, 0]]], [2, [[0, 1, 0, 1], [1, 2, 0, 1]]]] },
    // climbing ladder of alternating diagonals
    { name: 'ladder',       lo: 3, m: [[0, [[0, 0, 0, 5]]], [0.5, [[1, 3, 0, 4]]], [1, [[0, 1, 1, 6]]], [1.5, [[1, 2, 1, 7]]], [2, [[0, 0, 2, 4]]], [2.5, [[1, 3, 2, 5]]]] },
    // squeeze: both hands swing inward, then open back out
    { name: 'squeeze',      lo: 3, m: [[0, [[0, 0, 1, 3]]], [0.5, [[1, 3, 1, 2]]], [1, [[0, 1, 1, 2]]], [1.5, [[1, 2, 1, 3]]]] },
    // corner cross: opposite corners trade down and up swings
    { name: 'corner-cross', lo: 3, m: [[0, [[0, 0, 2, 1]]], [0.5, [[1, 3, 0, 0]]], [1, [[0, 0, 1, 0]]], [1.5, [[1, 3, 1, 1]]]] },
    // quick answer pairs, a quarter beat apart
    { name: 'burst-answer', lo: 4, m: [[0, [[0, 1, 1, 1]]], [0.25, [[1, 2, 1, 1]]], [0.5, [[0, 1, 2, 0]]], [0.75, [[1, 2, 2, 0]]]] }
  ];
  ns.BUILTIN_COMBOS = BUILTIN_COMBOS;

  // ---- mining ----
  // notes: the map's notes sorted by time; toB converts map beats to detected beats (identity without audio)
  ns.minePatterns = function (brain, notes, toB, diff) {
    const P = brain.patterns;
    const lo = DIFF_IDX[diff] === undefined ? 3 : DIFF_IDX[diff];
    // group into moments
    const moments = [];
    for (const n of notes) {
      if (n.dir < 0 || n.dir > 8 || n.lane < 0 || n.lane > 3 || n.layer < 0 || n.layer > 2) continue;
      const t = toB(n.time);
      const last = moments[moments.length - 1];
      if (last && Math.abs(t - last.t) < 0.02) last.notes.push([n.color, n.lane, n.layer, n.dir]);
      else moments.push({ t: t, notes: [[n.color, n.lane, n.layer, n.dir]] });
    }
    const index = new Map();
    P.list.forEach(function (e, i) { index.set(e.k, i); });
    let added = 0;
    for (let L = 3; L <= 5; L++) {
      for (let i = 0; i + L <= moments.length; i++) {
        let ok = true;
        for (let j = 1; j < L; j++) if (moments[i + j].t - moments[i + j - 1].t > 1.01 || moments[i + j].t - moments[i + j - 1].t < 0.1) { ok = false; break; }
        if (!ok) continue;
        if (moments.slice(i, i + L).some(function (mo) { return mo.notes.length > 2; })) continue;
        const t0 = moments[i].t;
        const m = [];
        for (let j = 0; j < L; j++) {
          const mo = moments[i + j];
          const notes = mo.notes.slice().sort(function (a, b) { return a[0] - b[0]; });
          m.push([Math.round((mo.t - t0) * 24) / 24, notes]);
        }
        const mir = mirrorMotif(m);
        for (const mm of mir) mm[1].sort(function (a, b) { return a[0] - b[0]; });
        const k1 = keyOf(m), k2 = keyOf(mir);
        const k = k1 < k2 ? k1 : k2;
        if (index.has(k)) { const e = P.list[index.get(k)]; e.n++; e.lo = Math.min(e.lo, lo); continue; }
        const canon = k1 < k2 ? m : mir;
        index.set(k, P.list.length);
        P.list.push({ k: k, n: 1, lo: lo, t: +techScore(canon).toFixed(3), m: canon });
        added++;
      }
    }
    // keep the library bounded: frequent and technical motifs survive
    if (P.list.length > MAX_MINED) {
      P.list.sort(function (a, b) { return (b.n + 6 * b.t) - (a.n + 6 * a.t); });
      P.list.length = MAX_MINED;
    }
    P.seen = (P.seen || 0) + 1;
    return added;
  };

  // library for the generator: { combos: [...], motifs: [...] }, each with mirrored variants resolved at use time
  ns.patternLibrary = function (brain, diff) {
    const lo = DIFF_IDX[diff] === undefined ? 3 : DIFF_IDX[diff];
    const motifs = [];
    for (const b of BUILTIN_MOTIFS) if (b.lo <= lo) motifs.push({ name: b.name, m: b.m, n: 3, t: techScore(b.m), lo: b.lo, built: true });
    const mined = brain && brain.patterns ? brain.patterns.list : [];
    for (const e of mined) if (e.lo <= lo) motifs.push({ name: 'learned', m: e.m, n: e.n, t: e.t, lo: e.lo });
    const combos = BUILTIN_COMBOS.filter(function (c) { return c.lo <= lo; });
    return { combos: combos, motifs: motifs };
  };
})(BSM);
