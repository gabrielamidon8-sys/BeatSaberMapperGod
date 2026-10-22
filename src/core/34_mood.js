/* Emotional reading of a song, and lighting that follows it.
 *
 * Mood per section comes from two axes measured on the audio:
 *   arousal    how much is going on: loudness, onset density, kick and snare rate
 *   brightness timbre, from the balance of high and low frequencies (dark and warm .. bright and airy)
 * which place a section among six feelings:
 *   somber / calm     low arousal, dark / bright
 *   tense / uplifting medium arousal, dark / bright
 *   aggressive / euphoric  high arousal, dark / bright
 * plus a "build" flag on the bars that lead into a drop.
 * Each feeling has a colour policy and a light vocabulary (see PALETTE and planMoodLights). */
(function (ns) {
  'use strict';

  const LIGHT = ns.LIGHT, GROUP = ns.GROUP;
  // main / alt colour, how hard the lights hit, how busy they are
  const FEEL = {
    somber:     { main: 'BLUE', alt: 'BLUE',  hard: 0.15, busy: 0.30, color1: 0.9 },
    calm:       { main: 'BLUE', alt: 'WHITE', hard: 0.20, busy: 0.40, color1: 0.8 },
    tense:      { main: 'RED',  alt: 'BLUE',  hard: 0.50, busy: 0.60, color1: 0.3 },
    uplifting:  { main: 'BLUE', alt: 'RED',   hard: 0.65, busy: 0.75, color1: 0.5 },
    aggressive: { main: 'RED',  alt: 'BLUE',  hard: 1.00, busy: 1.00, color1: 0.15 },
    euphoric:   { main: 'RED',  alt: 'BLUE',  hard: 0.90, busy: 1.00, color1: 0.5 }
  };
  ns.FEEL = FEEL;

  function clamp01(x) { return ns.clamp(x, 0, 1); }

  // Compute and cache the song's emotional map on the analysis object.
  ns.analyzeMood = function (an) {
    if (an.mood) return an.mood;
    const K = an.beatCount;
    const onPer = new Float32Array(K);
    if (an.onsetTimes) for (let i = 0; i < an.onsetTimes.length; i++) {
      const k = Math.floor((an.onsetTimes[i] - an.phase) / an.period);
      if (k >= 0 && k < K) onPer[k]++;
    }
    const beatA = new Float32Array(K);
    for (let k = 0; k < K; k++) beatA[k] = clamp01(0.62 * an.beatEnergy[k] + 0.38 * clamp01(onPer[k] / 4));
    const bright = an.beatBright || new Float32Array(K).fill(0.5);

    // judge each section against the song itself, so a quiet song still has its own highs and lows
    const secs = an.sections.map(function (sec, i) {
      let a = 0, b = 0, n = 0;
      for (let k = sec.start; k < sec.end && k < K; k++) { a += beatA[k]; b += bright[k]; n++; }
      a = n ? a / n : 0; b = n ? b / n : 0.5;
      const tex = an.study && an.study.texture ? an.study.texture[i] : null;
      if (tex) a = clamp01(0.8 * a + 0.2 * clamp01((tex.kick + tex.snare) / 4));
      return { A: a, B: b, i: i };
    });
    const aS = secs.map(function (s) { return s.A; }).sort(function (x, y) { return x - y; });
    const bS = secs.map(function (s) { return s.B; }).sort(function (x, y) { return x - y; });
    const q = function (arr, p) { return arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))]; };
    const aLo = q(aS, 0.33), aHi = q(aS, 0.66), bMid = q(bS, 0.5);
    const sections = secs.map(function (s) {
      const level = s.A < aLo ? 0 : (s.A < aHi ? 1 : 2);
      const bright2 = s.B >= bMid;
      const emotion = level === 0 ? (bright2 ? 'calm' : 'somber') : level === 1 ? (bright2 ? 'uplifting' : 'tense') : (bright2 ? 'euphoric' : 'aggressive');
      return { emotion: emotion, A: s.A, B: s.B };
    });
    // bars that lead into a drop
    const builds = [];
    an.sections.forEach(function (sec, i) {
      if (i + 1 < an.sections.length && an.sections[i + 1].drop) {
        const len = Math.min(8, sec.end - sec.start);
        builds.push({ start: sec.end - Math.min(len, 8), end: sec.end, drop: sec.end });
      }
    });
    an.mood = { sections: sections, beatA: beatA, beatB: bright, builds: builds };
    return an.mood;
  };
  ns.moodSectionAt = function (an, k) {
    const m = ns.analyzeMood(an);
    for (let i = 0; i < an.sections.length; i++) if (k >= an.sections[i].start && k < an.sections[i].end) return { i: i, sec: an.sections[i], mood: m.sections[i], feel: FEEL[m.sections[i].emotion] };
    const j = an.sections.length - 1;
    return { i: j, sec: an.sections[j], mood: m.sections[j], feel: FEEL[m.sections[j].emotion] };
  };
  ns.buildAt = function (an, k) {
    for (const b of ns.analyzeMood(an).builds) if (k >= b.start && k < b.end) return { progress: (k - b.start) / Math.max(1, b.end - b.start), b: b };
    return null;
  };

  /* Classic (v2) light events that follow the song's feeling, its instruments and its build-ups.
   *   kick   -> centre lights      snare -> back lights and rings      hat -> side lasers (quick, on busy sections)
   *   lead   -> a side laser coloured by its pitch (low red, high blue, in between white)
   * Calm music gets slow fades and sparse hits; aggressive music gets hard flashes on nearly every attack.
   * Before a drop the show builds (flashes double their rate each beat), goes dark for one beat, then lights everything white. */
  ns.planMoodLights = function (an, cfg, rng) {
    const mood = ns.analyzeMood(an);
    const P = an.period;
    const amount = cfg.lightAmount === undefined ? 1 : cfg.lightAmount;
    const sens = cfg.lightMood === undefined ? 1 : cfg.lightMood;
    const ev = [];
    const push = function (bs, type, value) { ev.push({ time: bs, type: type, value: value, float: 1 }); };
    const col = function (name) { return LIGHT[name]; };
    const inSec = function (list, sec) {
      const t0 = an.phase + sec.start * P, t1 = an.phase + sec.end * P;
      return list.filter(function (e) { return e.t >= t0 && e.t < t1; });
    };
    const bsT = function (t) { return t / P; };
    const bsK = function (k) { return (an.phase + k * P) / P; };
    const hasInst = !!an.inst;

    an.sections.forEach(function (sec, si) {
      const m = mood.sections[si], F = FEEL[m.emotion];
      const main = col(F.main), alt = col(F.alt), white = LIGHT.WHITE;
      const start = bsK(sec.start);
      // the feeling's opening gesture
      push(start, GROUP.BACK, main.trans);
      push(start, GROUP.CENTER, (m.A > 0.5 ? white : main).on);
      push(start, GROUP.LEFT, main.on);
      push(start, GROUP.RIGHT, alt.on);
      push(start, 12, Math.max(1, Math.round(1 + m.A * 6 * (0.5 + 0.5 * sens))));
      push(start, 13, Math.max(1, Math.round(1 + m.A * 6 * (0.5 + 0.5 * sens))));
      if (sec.drop) {
        for (const g of [GROUP.BACK, GROUP.RING, GROUP.CENTER, GROUP.LEFT, GROUP.RIGHT]) push(start, g, white.flash);
        push(start, 9, 1);
      }
      // bar-level: calm sections breathe, loud ones spin
      for (let k = sec.start; k < sec.end; k++) {
        const bar = (((k - an.downbeat) % 4) + 4) % 4 === 0;
        if (!bar) continue;
        const bs = bsK(k);
        if (F.hard < 0.4) { if (rng.chance(0.6 * amount)) push(bs, GROUP.RING, main.fade); }
        else { push(bs, GROUP.RING, (((k - sec.start) / 4) % 2 === 0 ? main : alt).flash); if (m.A > 0.6) push(bs, 8, 1); }
      }
      if (!hasInst) return;
      const busy = F.busy * amount * (0.5 + 0.5 * sens);
      // kick
      let last = -9;
      for (const e of inSec(an.inst.kick, sec)) {
        const bs = bsT(e.t);
        if (e.s < 0.5 || bs - last < 0.5 || !rng.chance(busy)) continue;
        last = bs;
        push(bs, GROUP.CENTER, F.hard >= 0.5 ? main.flash : main.fade);
        if (F.hard >= 0.9 && e.s > 0.8) push(bs, 9, 1);
      }
      // snare
      last = -9;
      for (const e of inSec(an.inst.snare, sec)) {
        const bs = bsT(e.t);
        if (e.s < 0.45 || bs - last < 0.5 || !rng.chance(busy)) continue;
        last = bs;
        push(bs, GROUP.BACK, F.hard >= 0.5 ? alt.flash : alt.fade);
        if (F.hard >= 0.5) push(bs, GROUP.RING, alt.flash);
      }
      // hats: quick side lasers, only where the feeling is busy
      if (F.busy >= 0.75) {
        last = -9; let side = 0;
        for (const e of inSec(an.inst.hat, sec)) {
          const bs = bsT(e.t);
          if (e.s < 0.55 || bs - last < 0.5 || !rng.chance(0.55 * busy)) continue;
          last = bs; side ^= 1;
          push(bs, side ? GROUP.LEFT : GROUP.RIGHT, (side ? alt : main).flash);
        }
      }
      // lead: colour follows pitch
      last = -9;
      for (const e of inSec(an.inst.lead, sec)) {
        const bs = bsT(e.t);
        if (e.s < 0.6 || bs - last < 1 || !rng.chance(0.7 * busy * sens + 0.1)) continue;
        last = bs;
        const c = e.p < 0.4 ? LIGHT.RED : (e.p > 0.6 ? LIGHT.BLUE : LIGHT.WHITE);
        push(bs, e.p < 0.5 ? GROUP.LEFT : GROUP.RIGHT, F.hard >= 0.5 ? c.flash : c.fade);
      }
    });

    // build-ups and the dark beat before a drop
    for (const b of mood.builds) {
      const len = b.end - b.start;
      for (let k = b.start; k < b.end - 1; k++) {
        const j = k - b.start;
        const n = j < len * 0.4 ? 1 : (j < len * 0.75 ? 2 : 4);
        for (let i = 0; i < n; i++) {
          const bs = bsK(k) + i / n;
          const c = (i % 2 === 0 ? LIGHT.RED : LIGHT.BLUE);
          push(bs, GROUP.RING, c.flash);
          if (j >= len * 0.4) push(bs, GROUP.BACK, (i % 2 ? LIGHT.RED : LIGHT.BLUE).flash);
        }
      }
      const dark = bsK(b.end - 1);
      for (const g of [GROUP.BACK, GROUP.RING, GROUP.CENTER, GROUP.LEFT, GROUP.RIGHT]) push(dark, g, LIGHT.OFF);
      push(dark, 12, 0); push(dark, 13, 0);
    }
    // keep the last word per light and moment (a blackout must beat an earlier flash)
    const seen = new Map();
    ev.forEach(function (e, i) { seen.set(e.type + '|' + Math.round(e.time * 1000), i); });
    const out = ev.filter(function (e, i) { return seen.get(e.type + '|' + Math.round(e.time * 1000)) === i; });
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  };
})(BSM);
