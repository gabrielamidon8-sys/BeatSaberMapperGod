/* Ingest: learn from a Beat Saber map .zip (v2, v3 or v4), and build the .zip the mapper exports. */
(function (ns) {
  'use strict';

  /* env: { inflateRaw(bytes)->Promise<Uint8Array>, decodeAudio(bytes)->Promise<{samples, sr}> | null }
   * Returns a short report and mutates brain in place. */
  ns.learnFromZip = async function (zipBytes, brain, env) {
    const files = await ns.unzipAll(zipBytes, env.inflateRaw);
    const infoBytes = ns.findFile(files, 'Info.dat');
    if (!infoBytes) throw new Error('No Info.dat inside this zip, so it is not a Beat Saber map.');
    const info = ns.parseInfo(JSON.parse(ns.bytesToText(infoBytes)));

    // The song gives every statistic its own beat grid. The map's BPM is passed as a hint so a half-time
    // detection is corrected to the tempo the mapper used.
    let analysis = null;
    const songBytes = ns.findFile(files, info.songFile);
    if (songBytes && env.decodeAudio) {
      try {
        const pcm = await env.decodeAudio(songBytes);
        analysis = ns.analyzeAudio(pcm.samples, pcm.sr, { bpmHint: info.bpm });
      } catch (e) {
        analysis = null; // map statistics still learn without the song-aware part
      }
    }

    // Prefer Standard. A variant (Lawless, 90 degree...) of a difficulty that also exists as Standard is
    // nearly the same pattern, and counting it twice would double its weight.
    const standard = new Set(info.difficulties.filter(function (d) { return d.characteristic === 'Standard'; }).map(function (d) { return d.name; }));
    const names = [];
    let notes = 0, skipped = 0, art = 0;
    const lightLearned = new Set();
    let lightBars = 0;
    for (const d of info.difficulties) {
      if (d.characteristic !== 'Standard' && standard.has(d.name)) { skipped++; continue; }
      const bytes = ns.findFile(files, d.file);
      if (!bytes) continue;
      let map;
      try { map = ns.parseDifficulty(JSON.parse(ns.bytesToText(bytes))); } catch (e) { continue; }
      ns.learnFromMap(brain, map, { name: info.songName, difficulty: d.name, bpm: info.bpm }, analysis);
      names.push(d.name);
      notes += map.notes.length;
      art += map.walls.filter(ns.isArtWall).length;
      // v4: the lightshow is a separate file, shared by the difficulties that name it
      if (d.lightshow && !lightLearned.has(d.lightshow)) {
        lightLearned.add(d.lightshow);
        const lb = ns.findFile(files, d.lightshow);
        if (lb) {
          try {
            const r = ns.learnLightshow(brain, ns.parseLightshow4(JSON.parse(ns.bytesToText(lb))), info.bpm, analysis);
            lightBars += r.bars;
          } catch (e) { /* a lightshow that cannot be read does not stop the gameplay learning */ }
        }
      }
    }
    if (!names.length) throw new Error('Found Info.dat but no difficulty files I could read.');
    return {
      songName: info.songName,
      bpm: info.bpm,
      detectedBpm: analysis ? analysis.bpm : null,
      difficulties: names,
      skippedVariants: skipped,
      notes: notes,
      artWalls: art,
      lightShows: lightLearned.size,
      withAudio: !!analysis
    };
  };

  /* Build the playable map zip.
   * v2 (classic):  { info (from makeInfo), maps: { Expert: map, ... }, audio: Uint8Array|null, cover: Uint8Array|null }
   * v4 (modern):   { format: 'v4', meta: { songName, artist, mapper, bpm, duration, environment },
   *                  maps, audio, cover, songFile, sampleCount, frequency }       */
  ns.buildMapZip = function (o) {
    if (o.format === 'v4') return buildV4(o);
    const files = [];
    files.push({ name: 'Info.dat', data: ns.textToBytes(JSON.stringify(o.info, null, 2)) });
    for (const name of Object.keys(o.maps)) {
      files.push({ name: name + '.dat', data: ns.textToBytes(JSON.stringify(ns.toV2(o.maps[name]))) });
    }
    if (o.cover) files.push({ name: 'cover.jpg', data: o.cover });
    if (o.audio) files.push({ name: 'song.ogg', data: o.audio });
    return ns.zipStore(files);
  };

  function buildV4(o) {
    const names = ns.DIFFICULTIES.filter(function (n) { return o.maps[n]; });
    const songFile = o.songFile || 'song.ogg';
    const info = ns.makeInfo4(Object.assign({}, o.meta, {
      difficulties: names.map(function (n) { return { name: n, file: n + 'Standard.dat', lightshow: 'Lightshow.dat' }; }),
      songFile: songFile,
      coverFile: 'cover.jpg'
    }));
    const files = [];
    files.push({ name: 'Info.dat', data: ns.textToBytes(JSON.stringify(info, null, 2)) });
    files.push({ name: 'AudioData.dat', data: ns.textToBytes(JSON.stringify(ns.makeAudioData4(o.sampleCount, o.frequency, o.meta.bpm), null, 2)) });
    for (const n of names) files.push({ name: n + 'Standard.dat', data: ns.textToBytes(JSON.stringify(ns.toV4(o.maps[n]))) });
    // one lightshow serves every difficulty; it is composed once per song
    let lights = { groups: [], boosts: [], basic: [] };
    if (o.lightMode === 'classic') {
      // classic light events (rings, lasers, back lights...) in the lightshow's basic-event list: the original
      // environment and ChroMapper both draw these; the learned light-group show needs the Collider environment
      for (const n of names) {
        const ev = o.maps[n].events || [];
        if (ev.length) { lights.basic = ev.map(function (e) { return { time: e.time, t: e.type, i: e.value, f: e.float === undefined ? 1 : e.float }; }); break; }
      }
    } else {
      for (const n of names) if (o.maps[n].lights4) { lights = o.maps[n].lights4; break; }
    }
    files.push({ name: 'Lightshow.dat', data: ns.textToBytes(JSON.stringify(ns.buildLightshow4(lights))) });
    if (o.cover) files.push({ name: 'cover.jpg', data: o.cover });
    if (o.audio) files.push({ name: songFile, data: o.audio });
    return ns.zipStore(files);
  }
})(BSM);
