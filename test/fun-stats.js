const fs=require('fs');const {loadCore}=require('./lib.js');const BSM=loadCore();
const b=fs.readFileSync(process.argv[2]);const x=new Float32Array(b.buffer,b.byteOffset,b.length/4);
const brain=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const an=BSM.analyzeAudio(x,44100);
const style=process.argv[4]||'balanced';
for(const diff of ['Hard','Expert','ExpertPlus']){
 const r=BSM.generateMap(an,{difficulty:diff,style,seed:5,candidates:2},brain); if(!global.shown){global.shown=1;console.log(Object.keys(r));}
 const rep=BSM.validateMap?BSM.validateMap(r.map):null;
 console.log(diff,'notes',r.map.notes.length,'nps',(r.map.notes.length/an.duration).toFixed(2),'chains',r.map.chains.length,'fills',r.meta.fills,'crashes',r.meta.crashes,'builtin patterns',r.meta.builtPatterns,'streamHits',r.meta.streamHits,'errors',rep?rep.errors.length:'?', rep&&rep.errors.slice(0,2));
}
