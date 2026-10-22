const fs=require('fs');const {loadCore}=require('./lib.js');const BSM=loadCore();
const b=fs.readFileSync(process.argv[2]);const x=new Float32Array(b.buffer,b.byteOffset,b.length/4);
const opts=process.argv[3]?{bpmHint:+process.argv[3]}:undefined;
const an=BSM.analyzeAudio(x,44100,opts);
console.log('bpm',an.bpm.toFixed(3),'detected(pre)',an.detectedBpm.toFixed(2),'octave',an.tempoOctave,'drift',JSON.stringify(an.drift),'phase',an.phase.toFixed(4),'conf',an.tempoConfidence.toFixed(2));
