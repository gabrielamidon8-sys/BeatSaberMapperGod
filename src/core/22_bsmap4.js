/* Beat Saber v4 support: read difficulty + Lightshow.dat + Info, and write the same.
 *
 * v4 stores notes, walls and light events in shared tables:  an instance ({b, i}) points at a data row.
 * For learning and re-use we "resolve" those tables into self-contained objects, and when writing we
 * rebuild the tables by de-duplicating identical objects (same result Beat Saber's own tools produce).
 *
 * Resolved light group (what the brain stores and the generator replays):
 *   { b: beat, g: group id, t: 1 color | 2 rotation | 3 translation | 4 fx,
 *     e: [ { f: indexFilter, x: eventBox, l: [ { b: beatOffset, v: event } ] } ] }
 * Group ids are specific to the lighting environment (the reference uses ColliderEnvironment).
 */
(function (ns) {
  'use strict';

  function r6(x) { return Math.round(x * 1e6) / 1e6; }

  // ---------- reading ----------
  function parseDifficulty4(obj) {
    const map = ns.emptyMap();
    map.extras = { arcs: (obj.arcs || []).length, chains: (obj.chains || []).length, njsEvents: (obj.njsEvents || []).length };
    const nd = obj.colorNotesData || [];
    for (const n of (obj.colorNotes || [])) {
      const d = nd[n.i];
      if (!d) continue;
      map.notes.push({ time: n.b, lane: d.x, layer: d.y, color: d.c === 1 ? 1 : 0, dir: d.d, angle: d.a || 0 });
    }
    const bd = obj.bombNotesData || [];
    for (const b of (obj.bombNotes || [])) {
      const d = bd[b.i];
      if (d) map.bombs.push({ time: b.b, lane: d.x, layer: d.y });
    }
    const od = obj.obstaclesData || [];
    for (const o of (obj.obstacles || [])) {
      const d = od[o.i];
      if (!d || !(d.d > 0)) continue;
      // a wall that starts at the top (y >= 2) is a crouch wall; anything else blocks the lanes it covers
      const w = { time: o.b, lane: d.x, type: d.y >= 2 ? 1 : 0, dur: d.d, width: d.w, y: d.y, h: d.h };
      w.art = ns.isArtWall(w);
      map.walls.push(w);
    }
    const by = function (a, b) { return a.time - b.time; };
    map.notes.sort(by); map.bombs.sort(by); map.walls.sort(by);
    return map;
  }
  ns.parseDifficulty4 = parseDifficulty4;

  const BOX_TABLES = {
    1: ['lightColorEventBoxes', 'lightColorEvents'],
    2: ['lightRotationEventBoxes', 'lightRotationEvents'],
    3: ['lightTranslationEventBoxes', 'lightTranslationEvents'],
    4: ['fxEventBoxes', 'floatFxEvents']
  };

  function parseLightshow4(obj) {
    const filters = obj.indexFilters || [];
    const groups = [];
    let dropped = 0;
    for (const g of (obj.eventBoxGroups || [])) {
      const tb = BOX_TABLES[g.t];
      if (!tb) { dropped++; continue; }
      const boxes = obj[tb[0]] || [], evs = obj[tb[1]] || [];
      const e = [];
      for (const eb of (g.e || [])) {
        const f = filters[eb.f], x = boxes[eb.e];
        if (!f || !x) { dropped++; continue; }
        const l = [];
        for (const ev of (eb.l || [])) {
          const v = evs[ev.i];
          if (v) l.push({ b: ev.b, v: v });
        }
        e.push({ f: f, x: x, l: l });
      }
      groups.push({ b: g.b, g: g.g, t: g.t, e: e });
    }
    groups.sort(function (a, b) { return a.b - b.b; });
    const boostData = obj.colorBoostEventsData || [];
    const boosts = (obj.colorBoostEvents || []).map(function (e) {
      const d = boostData[e.i];
      return { time: e.b, on: !!(d && d.b) };
    });
    const basicData = obj.basicEventsData || [];
    const basic = [];
    for (const e of (obj.basicEvents || [])) {
      const d = basicData[e.i];
      if (d) basic.push({ time: e.b, t: d.t, i: d.i, f: d.f });
    }
    return { groups: groups, boosts: boosts, basic: basic, dropped: dropped };
  }
  ns.parseLightshow4 = parseLightshow4;

  // ---------- writing ----------
  function Table() {
    const items = [], index = new Map();
    return {
      items: items,
      add: function (o) {
        const k = JSON.stringify(o);
        let i = index.get(k);
        if (i === undefined) { i = items.length; items.push(o); index.set(k, i); }
        return i;
      }
    };
  }

  // Difficulty file, v4.1.0 key set (same as the reference map). Walls are written as v4 obstacles.
  function toV4(map) {
    const nd = Table(), bd = Table(), od = Table();
    const notes = map.notes.map(function (n) {
      return { b: r6(n.time), r: 0, i: nd.add({ x: n.lane, y: n.layer, c: n.color, d: n.dir, a: n.angle || 0 }) };
    });
    const bombs = map.bombs.map(function (b) { return { b: r6(b.time), r: 0, i: bd.add({ x: b.lane, y: b.layer }) }; });
    const walls = map.walls.map(function (w) {
      const row = w.y !== undefined
        ? { x: w.lane, y: w.y, d: r6(w.dur), w: w.width, h: w.h }
        : (w.type === 1 ? { x: w.lane, y: 2, d: r6(w.dur), w: w.width, h: 3 } : { x: w.lane, y: 0, d: r6(w.dur), w: w.width, h: 5 });
      return { b: r6(w.time), r: 0, i: od.add(row) };
    });
    const cd = Table();
    const chains = (map.chains || []).map(function (c) {
      return { hb: r6(c.time), hr: 0, tb: r6(c.tailTime), tr: 0,
        i: nd.add({ x: c.lane, y: c.layer, c: c.color, d: c.dir, a: 0 }),
        ci: cd.add({ tx: c.tx, ty: c.ty, c: c.slices, s: c.squish }) };
    });
    return {
      version: '4.1.0',
      colorNotes: notes, colorNotesData: nd.items,
      bombNotes: bombs, bombNotesData: bd.items,
      arcs: [], arcsData: [],
      chains: chains, chainsData: cd.items,
      obstacles: walls, obstaclesData: od.items,
      njsEvents: [], njsEventData: []
    };
  }
  ns.toV4 = toV4;

  // Lightshow.dat (v4.0.0). ls = { groups, boosts: [{time, on}], basic: [{time, t, i, f}] }
  function buildLightshow4(ls) {
    const filters = Table();
    const boxes = { 1: Table(), 2: Table(), 3: Table(), 4: Table() };
    const evs = { 1: Table(), 2: Table(), 3: Table(), 4: Table() };
    const basicData = Table(), boostData = Table();
    const groups = ls.groups.slice().sort(function (a, b) { return a.b - b.b; }).map(function (g) {
      return {
        b: r6(g.b), g: g.g, t: g.t,
        e: g.e.map(function (eb) {
          return {
            f: filters.add(eb.f),
            e: boxes[g.t].add(eb.x),
            l: eb.l.map(function (l) { return { b: r6(l.b), i: evs[g.t].add(l.v) }; })
          };
        })
      };
    });
    const basic = (ls.basic || []).slice().sort(function (a, b) { return a.time - b.time || a.t - b.t; }).map(function (e) { return { b: r6(e.time), i: basicData.add({ t: e.t, i: e.i, f: e.f }) }; });
    const boosts = (ls.boosts || []).map(function (e) { return { b: r6(e.time), i: boostData.add({ b: e.on ? 1 : 0 }) }; });
    return {
      version: '4.0.0',
      basicEvents: basic, basicEventsData: basicData.items,
      colorBoostEvents: boosts, colorBoostEventsData: boostData.items,
      waypoints: [], waypointsData: [],
      indexFilters: filters.items,
      eventBoxGroups: groups,
      lightColorEventBoxes: boxes[1].items, lightColorEvents: evs[1].items,
      lightRotationEventBoxes: boxes[2].items, lightRotationEvents: evs[2].items,
      lightTranslationEventBoxes: boxes[3].items, lightTranslationEvents: evs[3].items,
      fxEventBoxes: boxes[4].items, floatFxEvents: evs[4].items,
      basicEventTypesWithKeywords: { d: [] },
      useNormalEventsAsCompatibleEvents: true
    };
  }
  ns.buildLightshow4 = buildLightshow4;

  // Info.dat (v4.0.1). o: { songName, artist, mapper, bpm, duration, songFile, coverFile, environment,
  //                         difficulties: [{ name, file, lightshow }] }
  function makeInfo4(o) {
    return {
      version: '4.0.1',
      song: { title: o.songName || 'Generated map', subTitle: '', author: o.artist || 'Unknown artist' },
      audio: {
        songFilename: o.songFile || 'song.ogg',
        songDuration: Math.round((o.duration || 0) * 1000) / 1000,
        audioDataFilename: 'AudioData.dat',
        bpm: Math.round(o.bpm * 100000) / 100000,
        lufs: 0.0,
        previewStartTime: o.previewStart || 12,
        previewDuration: o.previewDuration || 12
      },
      songPreviewFilename: o.songFile || 'song.ogg',
      coverImageFilename: o.coverFile || 'cover.jpg',
      environmentNames: [o.environment || 'ColliderEnvironment'],
      colorSchemes: [],
      difficultyBeatmaps: o.difficulties.map(function (d) {
        return {
          characteristic: 'Standard',
          difficulty: d.name,
          beatmapAuthors: { mappers: [o.mapper || 'BSM Generative Mapper'], lighters: [] },
          environmentNameIdx: 0,
          beatmapColorSchemeIdx: 0,
          noteJumpMovementSpeed: ns.DIFF_NJS[d.name] || 10,
          noteJumpStartBeatOffset: 0,
          beatmapDataFilename: d.file,
          lightshowDataFilename: d.lightshow,
          customData: {}
        };
      }),
      customData: { editors: { lastEditedBy: 'BSM Generative Mapper' } }
    };
  }
  ns.makeInfo4 = makeInfo4;

  // AudioData.dat (v4.0.0): ties the song's sample range to the beat count.
  function makeAudioData4(sampleCount, frequency, bpm) {
    const seconds = sampleCount / frequency;
    return {
      version: '4.0.0',
      songChecksum: '',
      songSampleCount: sampleCount,
      songFrequency: frequency,
      bpmData: [{ si: 0, ei: sampleCount, sb: 0, eb: r6(seconds * bpm / 60) }],
      lufsData: []
    };
  }
  ns.makeAudioData4 = makeAudioData4;
})(BSM);
