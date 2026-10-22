// v4 reader/writer checks against the reference map.  node test/check-v4.js <ref2 dir>
const fs = require('fs'), path = require('path'), assert = require('assert');
const { loadCore } = require('./lib');
const BSM = loadCore();
const dir = process.argv[2];
const J = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const info = BSM.parseInfo(J('Info.dat'));
console.log('info', info.bpm, info.songFile, info.difficulties.map(d => d.characteristic + '/' + d.name).join(' '));
const raw = J('ExpertStandard.dat');
const map = BSM.parseDifficulty(raw);
assert.strictEqual(map.notes.length, raw.colorNotes.length, 'note count');
assert.strictEqual(map.walls.length, raw.obstacles.length, 'wall count');
const v = BSM.validateMap(map);
console.log('notes', map.notes.length, 'walls', map.walls.length, 'bombs', map.bombs.length, 'extras', JSON.stringify(map.extras), 'reach violations', v.reachViolations);
// difficulty round trip
const back = BSM.parseDifficulty(BSM.toV4(map));
assert.strictEqual(JSON.stringify(back.notes.map(n => [n.time, n.lane, n.layer, n.color, n.dir])), JSON.stringify(map.notes.map(n => [n.time, n.lane, n.layer, n.color, n.dir])), 'note roundtrip');
// lightshow round trip: resolve -> write -> resolve must be identical
const ls = BSM.parseLightshow4(J('Lightshow.dat'));
console.log('groups', ls.groups.length, 'dropped', ls.dropped, 'boosts', ls.boosts.length, 'basic', ls.basic.length);
assert.strictEqual(ls.dropped, 0, 'every group reference must resolve');
const out = BSM.buildLightshow4(ls);
const ls2 = BSM.parseLightshow4(out);
assert.strictEqual(JSON.stringify(ls2.groups), JSON.stringify(ls.groups), 'lightshow roundtrip');
const orig = J('Lightshow.dat');
console.log('tables  filters', orig.indexFilters.length, '->', out.indexFilters.length, ' color events', orig.lightColorEvents.length, '->', out.lightColorEvents.length, ' groups', orig.eventBoxGroups.length, '->', out.eventBoxGroups.length);
assert.deepStrictEqual(Object.keys(out).sort(), Object.keys(orig).sort(), 'same key set as the game-made file');
// index bounds
for (const g of out.eventBoxGroups) for (const e of g.e) assert(e.f < out.indexFilters.length);
console.log('v4 checks passed');
