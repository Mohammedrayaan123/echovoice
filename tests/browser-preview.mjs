// Local-only browser regression harness. No network/provider calls or real mic.
import { createApp } from '../server.js';
import { VoiceServiceError } from '../server/voiceService.js';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
function wav(seconds, silence=false) {
  const rate=16000, count=rate*seconds, out=Buffer.alloc(44+count*2);
  out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WAVEfmt ',8);out.writeUInt32LE(16,16);out.writeUInt16LE(1,20);out.writeUInt16LE(1,22);out.writeUInt32LE(rate,24);out.writeUInt32LE(rate*2,28);out.writeUInt16LE(2,32);out.writeUInt16LE(16,34);out.write('data',36);out.writeUInt32LE(count*2,40);
  for(let i=0;i<count;i++) out.writeInt16LE(silence?0:Math.round(Math.sin(i/rate*Math.PI*2*180)*5500),44+i*2);
  return out;
}
await mkdir('tests/.fixtures',{recursive:true});
await writeFile('tests/.fixtures/clear-synthetic.wav',wav(8));
await writeFile('tests/.fixtures/silent-synthetic.wav',wav(8,true));
const audio=wav(8).toString('base64');let sequence=0;
const profiles=new Map();
const profileStore={
  save:async(value)=>{const id=randomUUID();profiles.set(id,value);return id;},
  get:async(id)=>{const value=profiles.get(id);if(!value)throw new VoiceServiceError('Set up your voice again.','missing_voice_sample',400);return {...value,audio:value.file.buffer,mimetype:value.file.mimetype};},
};
const app=createApp({apiKey:'local-test-only',supabaseClient:null,saveLocalAudio:false,profileStore,idealGenerationService:{
  preview:async({text})=>{if(text.includes('TEST_ERROR'))throw new VoiceServiceError('The voice account has used its available credits.','quota_exceeded',402);return {success:true,audioBase64:audio,mimeType:'audio/wav',alignment:null};},
  plan:async({script,mode})=>({plannerId:'local-plan',instruction:`local ${mode}`,targetDuration:8,targetSpeed:1,measuredWpm:120}),
  generate:async({script})=>{if(script.includes('TEST_TIMEOUT')){const error=new VoiceServiceError('Voice generation is taking longer than expected.','OMNI_TIMEOUT',504);error.details={backupAvailable:true,backupUrl:'/__test/backup.wav'};throw error;}await new Promise(resolve=>setTimeout(resolve,8000));return {success:true,audioBase64:audio,mimeType:'audio/wav',alignment:null};},
},fetchImpl:async(url,opts)=>{
  if(url.endsWith('/voices/add')) return Response.json({voice_id:`testVoiceProfile${++sequence}`,requires_verification:false});
  if(url.includes('/text-to-speech/')) {
    const input=JSON.parse(opts.body);
    if(input.text.includes('TEST_ERROR')) return Response.json({detail:{status:'quota_exceeded'}},{status:402});
    const chars=[...input.text],step=8/chars.length;
    return Response.json({audio_base64:audio,alignment:{characters:chars,character_start_times_seconds:chars.map((_,i)=>i*step),character_end_times_seconds:chars.map((_,i)=>(i+1)*step)}});
  }
  throw new Error('Unexpected provider request in test');
}});
const script=`
const marker=document.createElement('div');marker.textContent='LOCAL TEST · synthetic audio · no external calls';marker.style.cssText='position:fixed;top:0;right:0;z-index:9999;font:10px monospace;background:#514514;color:#fff;padding:3px 8px';document.body.append(marker);
const fakeMicrophone=async()=>{const ctx=new AudioContext();await ctx.resume();const oscillator=ctx.createOscillator();oscillator.frequency.value=180;const gain=ctx.createGain();gain.gain.value=new URLSearchParams(location.search).has('quietMic')?.008:.17;const dest=ctx.createMediaStreamDestination();oscillator.connect(gain);gain.connect(dest);oscillator.start();const track=dest.stream.getAudioTracks()[0];const stop=track.stop.bind(track);track.stop=()=>{stop();oscillator.stop();ctx.close();};return dest.stream;};
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:fakeMicrophone,configurable:true});
Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{value:async()=>[],configurable:true});
`;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/__test/fixtures.js'){res.setHeader('Content-Type','text/javascript');res.end(script);return;}
  if(url.pathname==='/__test/backup.wav'){res.setHeader('Content-Type','audio/wav');res.end(wav(8));return;}
  if(url.pathname==='/') {
    const html=await readFile('public/index.html','utf8');res.setHeader('Content-Type','text/html');res.end(html.replace('<script type="module" src="js/app.js">','<script src="/__test/fixtures.js"></script><script type="module" src="js/app.js">'));return;
  }
  app(req,res);
});
server.listen(3215,'127.0.0.1',()=>console.log('Synthetic browser test: http://localhost:3215'));
