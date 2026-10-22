const fs=require('fs');const {loadCore}=require('./lib.js');const BSM=loadCore();
for (const [n,f,hint] of [['ref1','ref_mono_44k.f32',120],['ref2','ref2_mono_44k.f32',185]]) {
  const b=fs.readFileSync(process.argv[2]+'/'+f);const x=new Float32Array(b.buffer,b.byteOffset,b.length/4);
  const a=BSM.analyzeAudio(x,44100);
  const h=BSM.analyzeAudio(x,44100,{bpmHint:hint});
  const d=BSM.analyzeAudio(x,44100,{tempoScale:0.5});
  console.log(n,'auto',a.bpm.toFixed(2),'(raw',a.detectedBpm.toFixed(2),'octave',a.tempoOctave,') onsets/s',a.onsetRate.toFixed(2),'per beat',(a.onsetRate/(a.bpm/60)).toFixed(2),'| hint',hint,'->',h.bpm.toFixed(2),'| /2 ->',d.bpm.toFixed(2),'conf',a.tempoConfidence.toFixed(2));
}
