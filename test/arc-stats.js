const fs=require('fs');const {loadCore}=require('./lib.js');const BSM=loadCore();
const b=fs.readFileSync(process.argv[2]);const x=new Float32Array(b.buffer,b.byteOffset,b.length/4);
const brain=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const an=BSM.analyzeAudio(x,44100);
for (const c of [0,1,1.5]) {
 const r=BSM.generateMap(an,{difficulty:'Expert',seed:5,candidates:1,contrast:c},brain);
 const per={low:[0,0],mid:[0,0],high:[0,0],build:[0,0],drop:[0,0]};
 const bs=t=>Math.floor((t*an.period-an.phase)/an.period);
 const cnt=new Array(an.beatCount).fill(0); r.map.notes.forEach(n=>{const k=bs(n.time); if(k>=0&&k<cnt.length)cnt[k]++;});
 an.sections.forEach(s=>{for(let k=s.start;k<s.end&&k<cnt.length;k++){per[s.level][0]+=cnt[k];per[s.level][1]++; if(s.drop&&k-s.start<8){per.drop[0]+=cnt[k];per.drop[1]++;}}});
 for(const bd of BSM.analyzeMood(an).builds)for(let k=bd.start;k<bd.end;k++){per.build[0]+=cnt[k];per.build[1]++;}
 console.log('contrast',c,'notes/beat',Object.entries(per).map(([k,v])=>k+' '+(v[1]?(v[0]/v[1]).toFixed(2):'-')).join('  '),'total',r.map.notes.length);
}
