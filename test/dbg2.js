const fs=require('fs');const {loadCore}=require('./lib.js');const BSM=loadCore();
const b=fs.readFileSync(process.argv[2]);const x=new Float32Array(b.buffer,b.byteOffset,b.length/4);
const an=BSM.analyzeAudio(x,44100,{bpmHint:+process.argv[3]});
const D=BSM.__tempoDebug, prof=new Float64Array(192), env=an.onset2;
for (const bpm of [184,184.6,184.9,185,185.1,185.4,187.5, 92.5, 92.3]) { const P=60/bpm; console.log(bpm, D.foldScore(env,an.fps,P,192,env.length,prof,0).toExponential(4)); }
