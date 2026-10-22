# BeatSaberMapperGod (BeatForge)

A generative Beat Saber mapper that runs entirely in the browser. Drop in a song and it builds notes, dots, bombs, walls and lights that follow the music, and it learns its style from map `.zip` files you give it.

## What it does
- Finds tempo (with octave correction), beats, downbeats, onsets and sections in any song.
- Senses instruments (kick, snare, hat, lead with a pitch proxy) and finds bars that repeat, so notes follow what is playing and choreography repeats where the music does.
- Reads each section's feeling (somber, calm, tense, uplifting, aggressive, euphoric) and lights to it: kick, snare, hat and lead drive the lights, colors follow mood and pitch, and drops get a build-up, a dark beat and a white detonation.
- Generates Easy to Expert+ maps with swing-parity-aware flow, streams, chords, bombs, gameplay walls and decorative wall art.
- Learns from maps in v2, v3 and v4 formats (rhythm, flow, density, walls, wall art, and v4 light shows).
- Exports classic v2 maps or v4 maps with a composed light show.
- Has a perspective preview, a timeline and a playability check.

## Layout
- `src/core/` the engine (audio analysis, map formats, generator, brain, ingest)
- `src/app/template.html` the UI
- `build.js` bundles everything into one file: `node build.js` writes `dist/beat-mapper.html`
- `data/default-brain.json` the starting brain, learned from two reference maps
- `test/` checks and benchmarks (`node test/study-song.js song.f32` prints what the analyser hears; `node test/check-v4.js <v4 map dir>`, `node test/bench.js`, `node test/e2e-v4.js`)

## Known limits
- v4 light shows are only valid for the environment they were learned in (ColliderEnvironment) and have not been checked in game.
- Arcs, chains and NJS events are not generated.
- The style depends on the few maps it has learned from; add more maps to widen it.
- Only OGG audio goes into an exported zip.
