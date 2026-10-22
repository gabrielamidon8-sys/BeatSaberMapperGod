// local phase (circular mean, harmonic 2) of onsets per 15 s chunk for trial tempos
const fs=require('fs'),os=require('os'),path=require('path'),zlib=require('zlib');const {execFileSync}=require('child_process');
const {loadCore}=require('./lib.js');const BSM=loadCore();
(async()=>{
const files=await BSM.unzipAll(new Uint8Array(fs.readFileSync(process.argv[2])),async b=>new Uint8Array(zlib.inflateRawSync(Buffer.from(b))));
const info=BSM.parseInfo(JSON.parse(BSM.bytesToText(BSM.findFile(files,'Info.dat'))));
const d=fs.mkdtempSync(path.join(os.tmpdir(),'b-'));fs.writeFileSync(d+'/i',Buffer.from(BSM.findFile(files,info.songFile)));
execFileSync('ffmpeg',['-v','error','-y','-i',d+'/i','-ac','1','-ar','44100','-f','f32le',d+'/o.f32']);
const b=fs.readFileSync(d+'/o.f32');const x=new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));
const an=BSM.analyzeAudio(x,44100,{bpmHint:info.bpm});
const T=an.onsetTimes,env=an.onset2;
const W=[...T].map(t=>env[Math.round(t*an.fps)]);
for(const bpm of process.argv.slice(3).map(Number)){const P=60/bpm;const out=[];
 for(let c0=0;c0+15<=an.duration;c0+=15){let r=0,q=0;for(let i=0;i<T.length;i++)if(T[i]>=c0&&T[i]<c0+15){const th=4*Math.PI*T[i]/P;r+=W[i]*Math.cos(th);q+=W[i]*Math.sin(th);}
  out.push((Math.atan2(q,r)/(4*Math.PI)*P*1000).toFixed(0));}
 console.log(bpm,'local phase ms per chunk (mod P/2):',out.join(' '));}
})();
