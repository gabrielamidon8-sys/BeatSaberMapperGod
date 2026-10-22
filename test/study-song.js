// Print what the analyser senses in a song: instruments, texture, repeated bars.
const fs = require('fs');
const { loadCore } = require('./lib.js');
const BSM = loadCore();
const b = fs.readFileSync(process.argv[2]);
const an = BSM.analyzeAudio(new Float32Array(b.buffer, b.byteOffset, b.length / 4), 44100);
const c = k => an.inst[k].length;
console.log('bpm', an.bpm.toFixed(2), 'onsets', an.onsetTimes.length, 'broadband', Math.round(an.onsetRate * an.duration));
console.log('events kick', c('kick'), 'snare', c('snare'), 'hat', c('hat'), 'lead', c('lead'));
console.log('bars', an.study.bars, 'linked to an earlier similar bar', (100 * an.study.linkedShare).toFixed(0) + '%');
an.sections.forEach((s, i) => console.log(' section', i, s.level, s.drop ? 'drop' : '', JSON.stringify(an.study.texture[i])));
