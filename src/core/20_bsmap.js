/* Beat Saber map I/O (v2 write, v2 + v3 read), validation and statistics.
 *
 * Internal map representation (times are in beats):
 *   notes:  [{ time, lane, layer, color, dir }]   color 0 = red (left saber), 1 = blue (right saber)
 *                                                  lane 0..3 (left->right), layer 0..2 (bottom->top)
 *                                                  dir 0..8 (0 up,1 down,2 left,3 right,4 UL,5 UR,6 DL,7 DR,8 any/dot)
 *   bombs:  [{ time, lane, layer }]
 *   walls:  [{ time, lane, type, dur, width, y?, h?, art? }]
 *                                                  type 0 = full height, 1 = crouch (top); y/h = vertical extent (v4);
 *                                                  art = decorative wall outside the lanes (never blocks a note)
 *   events: [{ time, type, value, float }]        lighting events (v2)
 */
(function (ns) {
  'use strict';

  ns.DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
  ns.DIFF_RANK = { Easy: 1, Normal: 3, Hard: 5, Expert: 7, ExpertPlus: 9 };
  ns.DIFF_NJS = { Easy: 10, Normal: 10, Hard: 10, Expert: 12, ExpertPlus: 16 };
  ns.DIR_NAMES = ['Up', 'Down', 'Left', 'Right', 'Up-Left', 'Up-Right', 'Down-Left', 'Down-Right', 'Dot'];
  // mirror across the vertical centre line (red <-> blue in doubles)
  ns.MIRROR_DIR = [0, 1, 3, 2, 5, 4, 7, 6, 8];

  function r6(x) { return Math.round(x * 1e6) / 1e6; }

  function emptyMap() { return { notes: [], bombs: [], walls: [], events: [] }; }
  ns.emptyMap = emptyMap;

  // ---------- reading ----------
  function parseDifficulty(obj) {
    // v4 stores notes as indexes into data tables; it is handled in 22_bsmap4.js
    if (obj && obj.colorNotesData && ns.parseDifficulty4) return ns.parseDifficulty4(obj);
    const map = emptyMap();
    if (obj && Array.isArray(obj.colorNotes)) {
      // Beat Saber v3 layout
      for (const n of obj.colorNotes) {
        map.notes.push({ time: n.b, lane: n.x, layer: n.y, color: n.c === 1 ? 1 : 0, dir: n.d });
      }
      for (const b of (obj.bombNotes || [])) map.bombs.push({ time: b.b, lane: b.x, layer: b.y });
      for (const o of (obj.obstacles || [])) {
        map.walls.push({ time: o.b, lane: o.x, type: (o.h >= 4 ? 0 : 1), dur: o.d, width: o.w });
      }
      // v3 lighting events use different type numbers; they are not imported.
    } else {
      for (const n of (obj._notes || [])) {
        if (n._type === 0 || n._type === 1) {
          map.notes.push({ time: n._time, lane: n._lineIndex, layer: n._lineLayer, color: n._type, dir: n._cutDirection });
        } else if (n._type === 3) {
          map.bombs.push({ time: n._time, lane: n._lineIndex, layer: n._lineLayer });
        }
      }
      for (const o of (obj._obstacles || [])) {
        if (o._type === 0 || o._type === 1) {
          map.walls.push({ time: o._time, lane: o._lineIndex, type: o._type, dur: o._duration, width: o._width });
        }
      }
      for (const e of (obj._events || [])) {
        map.events.push({ time: e._time, type: e._type, value: e._value, float: e._floatValue === undefined ? 1 : e._floatValue });
      }
    }
    map.notes.sort(function (a, b) { return a.time - b.time; });
    map.bombs.sort(function (a, b) { return a.time - b.time; });
    map.walls.sort(function (a, b) { return a.time - b.time; });
    map.events.sort(function (a, b) { return a.time - b.time; });
    return map;
  }
  ns.parseDifficulty = parseDifficulty;

  // Info.dat -> { bpm, songFile, difficulties: [{ name, file }] }
  function parseInfo(obj) {
    if (Array.isArray(obj.difficultyBeatmaps)) {
      // Info v4
      const a = obj.audio || {};
      return {
        bpm: Number(a.bpm) || 120,
        songName: (obj.song && obj.song.title) || 'Untitled',
        artist: (obj.song && obj.song.author) || '',
        songFile: a.songFilename || 'song.ogg',
        coverFile: obj.coverImageFilename || 'cover.jpg',
        version: 4,
        difficulties: obj.difficultyBeatmaps.map(function (d) {
          return { name: d.difficulty, file: d.beatmapDataFilename, characteristic: d.characteristic || 'Standard', lightshow: d.lightshowDataFilename || '' };
        })
      };
    }
    const sets = obj._difficultyBeatmapSets || [];
    const diffs = [];
    for (const s of sets) {
      for (const d of (s._difficultyBeatmaps || [])) {
        diffs.push({ name: d._difficulty, file: d._beatmapFilename, characteristic: s._beatmapCharacteristicName || 'Standard' });
      }
    }
    return {
      bpm: Number(obj._beatsPerMinute) || 120,
      songName: obj._songName || 'Untitled',
      artist: obj._songAuthorName || '',
      songFile: obj._songFilename || 'song.ogg',
      coverFile: obj._coverImageFilename || 'cover.jpg',
      difficulties: diffs
    };
  }
  ns.parseInfo = parseInfo;

  // ---------- writing (Beat Saber v2 schema, what the reference map uses) ----------
  function toV2(map) {
    const notes = [];
    for (const n of map.notes) {
      notes.push({ _time: r6(n.time), _lineIndex: n.lane, _lineLayer: n.layer, _type: n.color, _cutDirection: n.dir });
    }
    for (const b of map.bombs) {
      notes.push({ _time: r6(b.time), _lineIndex: b.lane, _lineLayer: b.layer, _type: 3, _cutDirection: 0 });
    }
    notes.sort(function (a, b) { return a._time - b._time; });
    // classic v2 walls live inside the four lanes; wall art outside them is a v4 feature
    const walls = map.walls.filter(function (w) { return w.lane >= 0 && w.lane + w.width <= 4 && !w.art; }).map(function (w) {
      return { _time: r6(w.time), _lineIndex: w.lane, _type: w.type, _duration: r6(w.dur), _width: w.width };
    });
    const events = map.events.map(function (e) {
      return { _time: r6(e.time), _type: e.type, _value: e.value, _floatValue: e.float === undefined ? 1 : e.float };
    });
    return { _version: '2.0.0', _events: events, _notes: notes, _obstacles: walls };
  }
  ns.toV2 = toV2;

  function makeInfo(o) {
    const round2 = function (x) { return Math.round(x * 100) / 100; };
    return {
      _version: '2.0.0',
      _songName: o.songName || 'Generated map',
      _songSubName: '',
      _songAuthorName: o.artist || 'Unknown artist',
      _levelAuthorName: o.mapper || 'BSM Generative Mapper',
      _beatsPerMinute: Math.round(o.bpm * 100000) / 100000,   // keep the decimals: 0.01 BPM is already 12 ms of drift in 3 minutes
      _shuffle: 0,
      _shufflePeriod: 0.5,
      _previewStartTime: o.previewStart || 12,
      _previewDuration: o.previewDuration || 12,
      _songTimeOffset: 0,
      _songFilename: o.songFile || 'song.ogg',
      _coverImageFilename: o.coverFile || 'cover.jpg',
      _environmentName: 'DefaultEnvironment',
      _allDirectionsEnvironmentName: 'GlassDesertEnvironment',
      _difficultyBeatmapSets: [{
        _beatmapCharacteristicName: 'Standard',
        _difficultyBeatmaps: o.difficulties.map(function (d) {
          return {
            _difficulty: d.name,
            _difficultyRank: ns.DIFF_RANK[d.name] || 1,
            _beatmapFilename: d.name + '.dat',
            _noteJumpMovementSpeed: ns.DIFF_NJS[d.name] || 10,
            _noteJumpStartBeatOffset: 0
          };
        })
      }],
      _customData: { _editors: { _lastEditedBy: 'BSM Generative Mapper' } }
    };
  }
  ns.makeInfo = makeInfo;

  // ---------- geometry helpers ----------
  // Chebyshev distance between two cells
  function cellDist(a, b) { return Math.max(Math.abs(a.lane - b.lane), Math.abs(a.layer - b.layer)); }
  ns.cellDist = cellDist;

  // How many grid steps a hand may move in dt beats (generator + validator share this rule).
  // Reach is a matter of real time, not beats: a hand moves the same distance per second at any tempo.
  // period = seconds per beat of the map (defaults to 0.4, i.e. 150 BPM, where the old beat rule applied).
  function allowedReach(dt, period) {
    const sec = dt * (period || 0.4);
    if (sec >= 0.4) return 3;
    if (sec >= 0.2) return 2;
    if (sec >= 0.1) return 1;
    return 0;
  }
  ns.allowedReach = allowedReach;

  // A wall entirely outside the four lanes is decoration: it cannot touch a note.
  function isArtWall(w) { return w.art === true || !(w.lane < 4 && w.lane + w.width > 0); }
  ns.isArtWall = isArtWall;

  // ---------- validation ----------
  function validateMap(map, bpm) {
    const period = bpm ? 60 / bpm : 0.4;
    const errors = [], warnings = [];
    const seen = new Set();
    for (const n of map.notes) {
      if (!(n.lane >= 0 && n.lane <= 3 && n.layer >= 0 && n.layer <= 2)) errors.push('note out of grid at beat ' + n.time.toFixed(3));
      if (!(n.dir >= 0 && n.dir <= 8)) errors.push('bad cut direction at beat ' + n.time.toFixed(3));
      if (!(n.color === 0 || n.color === 1)) errors.push('bad color at beat ' + n.time.toFixed(3));
      const key = n.time.toFixed(4) + ':' + n.lane + ':' + n.layer;
      if (seen.has(key)) errors.push('two notes in the same cell at beat ' + n.time.toFixed(3));
      seen.add(key);
    }
    // hand reach (same colour)
    let reachViolations = 0;
    for (const color of [0, 1]) {
      const list = map.notes.filter(function (n) { return n.color === color; });
      for (let i = 1; i < list.length; i++) {
        const dt = list[i].time - list[i - 1].time;
        if (cellDist(list[i], list[i - 1]) > allowedReach(dt, period)) {
          // stacks / towers (same beat, one line) and sliders (a quick second note one cell along the same swing) are one swing
          const a = list[i - 1], b = list[i];
          const same = a.dir === b.dir && a.dir !== 8;
          const inLine = a.lane === b.lane || a.layer === b.layer || (Math.abs(a.lane - b.lane) === Math.abs(a.layer - b.layer));
          if (same && dt < 0.01 && cellDist(a, b) <= 2 && inLine) continue;
          if (same && dt <= 0.2 && cellDist(a, b) <= 1) continue;
          reachViolations++;
        }
      }
    }
    if (reachViolations) warnings.push(reachViolations + ' fast same-hand moves (reach)');
    // walls over notes
    let wallHits = 0;
    for (const w of map.walls) {
      if (isArtWall(w)) continue;
      for (const n of map.notes) {
        if (n.time >= w.time - 0.25 && n.time <= w.time + w.dur + 0.25) {
          const inLanes = n.lane >= w.lane && n.lane < w.lane + w.width;
          if (w.type === 0 && inLanes) wallHits++;
          if (w.type === 1 && inLanes && n.layer === 2) wallHits++;
        }
      }
    }
    if (wallHits) errors.push(wallHits + ' notes sit inside a wall window');
    // bombs next to notes
    let bombHits = 0;
    for (const b of map.bombs) {
      for (const n of map.notes) {
        if (Math.abs(n.time - b.time) < 0.25 && cellDist(n, b) <= 1) { bombHits++; break; }
      }
    }
    if (bombHits) warnings.push(bombHits + ' bombs too close to notes');
    return { errors: errors, warnings: warnings, reachViolations: reachViolations, wallHits: wallHits, bombHits: bombHits };
  }
  ns.validateMap = validateMap;

  // Everything later by a whole number of beats (a silent lead-in, for editors like ChroMapper that need a moment before beat 0).
  ns.shiftMap = function (map, beats) {
    if (!beats) return map;
    const mv = function (o) { return Object.assign({}, o, { time: o.time + beats }); };
    const out = Object.assign({}, map, {
      notes: map.notes.map(mv), bombs: map.bombs.map(mv), walls: map.walls.map(mv), events: map.events.map(mv),
      chains: (map.chains || []).map(function (c) { return Object.assign({}, c, { time: c.time + beats, tailTime: c.tailTime + beats }); })
    });
    if (map.lights4) {
      out.lights4 = {
        groups: map.lights4.groups.map(function (g) { return Object.assign({}, g, { b: g.b + beats }); }),
        boosts: map.lights4.boosts.map(mv),
        basic: (map.lights4.basic || []).map(mv)
      };
    }
    return out;
  };

  // ---------- statistics ----------
  function mapStats(map, bpm) {
    const color = map.notes;
    const lastBeat = Math.max(
      color.length ? color[color.length - 1].time : 0,
      map.bombs.length ? map.bombs[map.bombs.length - 1].time : 0,
      map.walls.length ? map.walls[map.walls.length - 1].time + map.walls[map.walls.length - 1].dur : 0
    );
    const seconds = Math.max(1, lastBeat * 60 / (bpm || 120));
    const dirs = new Array(9).fill(0);
    const cells = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    let dots = 0;
    for (const n of color) { dirs[n.dir] = (dirs[n.dir] || 0) + 1; cells[n.layer][n.lane]++; if (n.dir === 8) dots++; }
    // chords: same beat, both colours
    let chordBeats = 0;
    for (let i = 1; i < color.length; i++) if (Math.abs(color[i].time - color[i - 1].time) < 1e-4) chordBeats++;
    // peak NPS over a 4-beat window
    let peak = 0, j = 0;
    for (let i = 0; i < color.length; i++) {
      while (j < color.length && color[j].time - color[i].time < 4) j++;
      peak = Math.max(peak, j - i);
    }
    const peakNps = peak / (4 * 60 / (bpm || 120));
    const play = map.walls.filter(function (w) { return !isArtWall(w); });
    const fullWalls = play.filter(function (w) { return w.type === 0; }).length;
    return {
      notes: color.length,
      redNotes: color.filter(function (n) { return n.color === 0; }).length,
      blueNotes: color.filter(function (n) { return n.color === 1; }).length,
      bombs: map.bombs.length,
      walls: play.length,
      artWalls: map.walls.length - play.length,
      fullWalls: fullWalls,
      crouchWalls: play.length - fullWalls,
      events: map.events.length,
      dots: dots,
      chordBeats: chordBeats,
      seconds: seconds,
      nps: color.length / seconds,
      peakNps: peakNps,
      dirs: dirs,
      cells: cells,
      lastBeat: lastBeat
    };
  }
  ns.mapStats = mapStats;
})(BSM);
