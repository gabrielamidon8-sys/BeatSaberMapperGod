/* v4 lighting: learn a lightshow as a library of one-bar phrases, and compose a new show from it.
 *
 * A v4 lightshow is a list of timed "event box groups" (see 22_bsmap4.js). Group ids are specific to
 * the lighting environment, so the library is only valid for the environment it was learned in
 * (the reference map uses ColliderEnvironment).
 *
 * Learning: the show is cut into bars of 4 beats. Each bar keeps its groups (offset inside the bar plus
 * the resolved group), the loudness of the music under it, and whether it opens a section or a drop.
 * Identical bars are merged and counted.
 *
 * Composing: for every bar of the new song, a stored bar is chosen by how well its loudness matches,
 * a boost for section starts and drops, continuity with the previous bar inside a section, and a
 * penalty for repeating the same bar too soon. That keeps a section coherent, gives the drop its own
 * choreography, and still varies from bar to bar.
 */
(function (ns) {
  'use strict';

  const EB = 10;
  const MAX_BARS = 240;
  function eBucket(e) { return ns.clamp(Math.floor(e * EB), 0, EB - 1); }
  function q48(x) { return Math.round(x * 48) / 48; }
  function r3(x) { return Math.round(x * 1000) / 1000; }
  function idsOf(groups) { const s = new Set(); for (const g of groups) s.add(g.t + ':' + g.g); return s; }
  function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    a.forEach(function (x) { if (b.has(x)) inter++; });
    return inter / (a.size + b.size - inter);
  }

  // Groups are stored compactly: filters, boxes and events live once in shared tables (lib.tab) and a group
  // holds indexes:  { o, g, t, e: [[filterIdx, boxIdx, [[beatOffset, eventIdx], ...]], ...] }
  function makeInterner(lib) {
    const tab = lib.tab;
    const idx = { f: new Map(), x: {}, v: {} };
    tab.f.forEach(function (o, i) { idx.f.set(JSON.stringify(o), i); });
    for (const t of [1, 2, 3, 4]) {
      idx.x[t] = new Map(); idx.v[t] = new Map();
      tab.x[t].forEach(function (o, i) { idx.x[t].set(JSON.stringify(o), i); });
      tab.v[t].forEach(function (o, i) { idx.v[t].set(JSON.stringify(o), i); });
    }
    const add = function (list, map, obj) {
      const k = JSON.stringify(obj);
      let i = map.get(k);
      if (i === undefined) { i = list.length; list.push(obj); map.set(k, i); }
      return i;
    };
    return function (g, scale) {
      return {
        g: g.g, t: g.t,
        e: g.e.map(function (eb) {
          return [
            add(tab.f, idx.f, eb.f),
            add(tab.x[g.t], idx.x[g.t], eb.x),
            eb.l.map(function (l) { return [r3(l.b * scale), add(tab.v[g.t], idx.v[g.t], l.v)]; })
          ];
        })
      };
    };
  }
  function expand(lib, cg, b) {
    const tab = lib.tab;
    return {
      b: b, g: cg.g, t: cg.t,
      e: cg.e.map(function (x) {
        return { f: tab.f[x[0]], x: tab.x[cg.t][x[1]], l: x[2].map(function (l) { return { b: l[0], v: tab.v[cg.t][l[1]] }; }) };
      })
    };
  }

  // ls = parseLightshow4 result; bpm = the map's BPM; analysis = audio analysis of its song (optional)
  ns.learnLightshow = function (brain, ls, bpm, analysis) {
    ns.normalizeBrain(brain);
    const lib = brain.lightLib;
    const intern = makeInterner(lib);
    const spb = 60 / bpm;
    const an = analysis || null;
    // Same pulse (within 1%) -> keep the mapper's own beats exactly. Otherwise move onto the detected grid.
    const aligned = !!an && Math.abs(spb / an.period - 1) < 0.01;
    const scale = (an && !aligned) ? spb / an.period : 1;
    const toB = (an && !aligned) ? function (b) { return (b * spb - an.phase) / an.period; } : function (b) { return b; };

    const bars = new Map();
    let lastBar = 0;
    const init = [];
    for (const g of ls.groups) {
      const tb = toB(g.b);
      if (tb < 0) continue;
      const scaled = intern(g, scale);
      if (tb < 0.01) { init.push(Object.assign({ o: 0 }, scaled)); continue; }
      const j = Math.floor(tb / 4 + 1e-6);
      lastBar = Math.max(lastBar, j);
      if (!bars.has(j)) bars.set(j, []);
      bars.get(j).push(Object.assign({ o: q48(tb - 4 * j) }, scaled));
    }
    if (!lib.init.length && init.length) lib.init = init;

    const index = new Map();
    lib.bars.forEach(function (b, i) { index.set(JSON.stringify([b.e, b.g]), i); });
    for (let j = 0; j <= lastBar; j++) {
      const groups = bars.get(j) || [];
      let k0 = 4 * j;
      if (an && aligned) k0 = Math.floor((4 * j * spb - an.phase) / an.period);
      let e = 0.5, f = false, d = false;
      if (an) {
        let sum = 0, n = 0;
        for (let k = k0; k < k0 + 4; k++) if (k >= 0 && k < an.beatCount) { sum += an.beatEnergy[k]; n++; }
        if (n) e = sum / n;
        for (const s of an.sections) if (s.start >= k0 && s.start < k0 + 4) { f = true; if (s.drop) d = true; }
      }
      groups.sort(function (a, b) { return a.o - b.o || a.g - b.g; });
      const key = JSON.stringify([eBucket(e), groups]);
      if (index.has(key)) {
        const b = lib.bars[index.get(key)];
        b.n++; b.f = b.f || f; b.d = b.d || d;
      } else {
        index.set(key, lib.bars.length);
        lib.bars.push({ e: eBucket(e), f: f, d: d, n: 1, g: groups });
      }
    }
    // keep the library bounded: drop the least useful bars (rare, and not marking a section or a drop)
    if (lib.bars.length > MAX_BARS) {
      lib.bars.sort(function (a, b) { return (b.n + (b.f ? 5 : 0) + (b.d ? 5 : 0)) - (a.n + (a.f ? 5 : 0) + (a.d ? 5 : 0)); });
      lib.bars.length = MAX_BARS;
    }
    lib.maps++;
    return { bars: lib.bars.length, groups: ls.groups.length };
  };

  // ---- emotion layer ----
  // Library groups are tinted and dimmed to match the song's feeling, accents follow the kick and snare, and the show
  // builds, goes dark for a beat and detonates at drops. All of it reuses lights (group ids, filters, boxes) the learned show uses.
  function tint(v, feel, A, sens, bld, rng) {
    if (!v || v.b === undefined) return v;
    const o = Object.assign({}, v);
    if (o.b > 0) o.b = ns.clamp(o.b * (1 + sens * (A - 0.5) * 0.9), 0.05, 1);
    if (o.c === 0 || o.c === 1) {
      if (bld) {
        if (rng() < sens * (0.3 + 0.5 * bld.progress)) { o.c = 2; o.b = Math.min(1, o.b * 1.15); }
      } else if (rng() < 0.65 * sens) o.c = rng() < feel.color1 ? 1 : 0;
    }
    return o;
  }
  function accentKit(lib) {
    const use = new Map();
    for (const b of lib.bars) for (const g of b.g) if (g.t === 1) {
      const u = use.get(g.g) || { n: 0, e: g.e[0] };
      u.n += b.n; use.set(g.g, u);
    }
    const top = Array.from(use.entries()).sort(function (a, b) { return b[1].n - a[1].n; }).slice(0, 4);
    if (!top.length) return null;
    const tab = lib.tab;
    return top.map(function (t) { return { g: t[0], f: tab.f[t[1].e[0]], x: tab.x[1][t[1].e[1]] }; });
  }
  function accent(kit, i, bs, list) {
    const k = kit[i % kit.length];
    return {
      b: bs, g: k.g, t: 1,
      e: [{ f: k.f, x: k.x, l: list.map(function (a) { return { b: a.o, v: { e: -1, p: a.p || 0, c: a.c, b: a.b, f: 0, sb: 0, sf: 0 } }; }) }]
    };
  }

  // -> { groups, boosts, basic } or null when the brain has no v4 lighting to draw on
  ns.planLights4 = function (an, cfg, brain, rng) {
    const lib = ns.normalizeBrain(brain).lightLib;
    if (!lib.bars.length) return null;
    const P = an.period, A = an.phase, K = an.beatCount;
    const bsOf = function (k) { return (A + k * P) / P; };
    const out = [];
    for (const g of lib.init) out.push(expand(lib, g, 0));

    const amount = cfg.lightAmount === undefined ? 1 : cfg.lightAmount;
    const sens = cfg.lightMood === undefined ? 1 : cfg.lightMood;
    const kit = an.inst ? accentKit(lib) : null;
    ns.analyzeMood(an);
    const recent = [];
    let prevIds = new Set();
    const first = ((an.downbeat % 4) + 4) % 4;
    for (let k = first; k + 1 < K; k += 4) {
      let sum = 0, n = 0;
      for (let i = k; i < k + 4 && i < K; i++) { sum += an.beatEnergy[i]; n++; }
      const e = n ? sum / n : 0;
      if (k > 0 && e < 0.03) continue;                    // silence: leave the show as it is
      if (k > 0 && amount < 1 && rng() > amount) continue;
      const eb = eBucket(e);
      let sec = null;
      for (const s of an.sections) if (s.start >= k && s.start < k + 4) sec = s;
      const weights = lib.bars.map(function (b, i) {
        let w = Math.exp(-0.8 * Math.abs(eb - b.e)) * Math.pow(b.n, 0.25);
        if (sec) { if (b.f) w *= 2.5; if (sec.drop && b.d) w *= 2.5; }
        else w *= 0.7 + 0.6 * jaccard(prevIds, idsOf(b.g));
        if (!b.g.length && e > 0.3) w *= 0.25;           // no dead bars in busy music
        let reps = 0;
        for (const r of recent) if (r === i) reps++;
        return w / (1 + 2 * reps);
      });
      const pick = rng.weighted(weights);
      const bar = lib.bars[pick];
      recent.push(pick);
      if (recent.length > 6) recent.shift();
      prevIds = idsOf(bar.g);
      const base = bsOf(k);
      const sm = ns.moodSectionAt(an, k), bld = ns.buildAt(an, k);
      for (const g of bar.g) {
        const x = expand(lib, g, base + g.o);
        if (x.t === 1 && sens > 0) x.e = x.e.map(function (eb) {
          return { f: eb.f, x: eb.x, l: eb.l.map(function (l) { return { b: l.b, v: tint(l.v, sm.feel, sm.mood.A, sens, bld, rng) }; }) };
        });
        out.push(x);
      }
      // accents on the kick and the snare (only where the music is lively)
      if (kit && sens > 0 && sm.mood.A > 0.35) {
        const t0 = an.phase + k * P, t1 = t0 + 4 * P;
        let kc = 0, sc = 0;
        for (const e of an.inst.kick) {
          if (e.t < t0 || e.t >= t1 || e.s < 0.65 || kc >= 3 || rng() > 0.55 * sens * sm.feel.busy) continue;
          kc++;
          out.push(accent(kit, 0, e.t / P, [{ o: 0, c: sm.feel.main === 'RED' ? 0 : 1, b: 0.9 }, { o: 0.3, c: 0, b: 0, p: 1 }]));
        }
        for (const e of an.inst.snare) {
          if (e.t < t0 || e.t >= t1 || e.s < 0.6 || sc >= 2 || rng() > 0.5 * sens * sm.feel.busy) continue;
          sc++;
          out.push(accent(kit, 1, e.t / P, [{ o: 0, c: sm.feel.alt === 'WHITE' ? 2 : (sm.feel.main === 'RED' ? 1 : 0), b: 1 }, { o: 0.25, c: 0, b: 0, p: 1 }]));
        }
      }
      // rising flashes through the last bar before a drop
      if (kit && sens > 0 && bld && bld.b.end - k <= 4 && bld.b.end - k > 0) {
        const lead = bsOf(bld.b.end - 4);
        for (let j = 0; j < 3; j++) {
          const n = [1, 2, 4][j];
          for (let i = 0; i < n; i++) out.push(accent(kit, 2 + (i % 2), lead + j + i / n, [{ o: 0, c: 2, b: 0.55 + 0.15 * j }, { o: 0.2 / n, c: 0, b: 0, p: 1 }]));
        }
      }
    }

    // the beat before a drop goes dark, then everything lights white
    let groups = out;
    if (kit && sens > 0) {
      const mood = ns.analyzeMood(an);
      for (const b of mood.builds) {
        const dark0 = bsOf(b.end - 1), dark1 = bsOf(b.end);
        groups = groups.filter(function (g) { return !(g.b >= dark0 - 1e-6 && g.b < dark1 - 1e-6) || g.accent; });
        for (let i = 0; i < Math.min(3, kit.length); i++) groups.push(accent(kit, i, dark1, [{ o: 0, c: 2, b: 1 }, { o: 1.5, c: 0, b: 0.3, p: 1 }]));
      }
    }
    // colour boost (the lights' alternate palette) while the feeling is at its biggest
    const boosts = [];
    let on = false;
    an.sections.forEach(function (s, i) {
      const e = ns.analyzeMood(an).sections[i].emotion;
      const want = s.level === 'high' || e === 'euphoric' || e === 'aggressive';
      if (want !== on) { boosts.push({ time: bsOf(s.start), on: want }); on = want; }
    });
    return { groups: groups, boosts: boosts, basic: [] };
  };
})(BSM);
