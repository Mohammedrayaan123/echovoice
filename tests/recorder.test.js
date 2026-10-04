import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceRecorder } from '../public/js/recorder.js';
class FakeRecorder extends EventTarget {
  static isTypeSupported(){return true;}
  constructor(stream,options){super();this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';}
  start(timeslice){this.state='recording';this.timeslice=timeslice;}
  stop(){this.state='inactive';queueMicrotask(()=>{this.dispatchEvent(Object.assign(new Event('dataavailable'),{data:new Blob(['audio'],{type:this.mimeType})}));this.dispatchEvent(new Event('stop'));});}
}
function fakeStream(){const track={stopped:0,stop(){this.stopped++;}};return {track,getTracks:()=>[track]};}
function install(getUserMedia){Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia}}});globalThis.MediaRecorder=FakeRecorder;}
test('capture requests microphone gain without noise filtering; repeated stop shares completion and releases microphone',async()=>{
  const stream=fakeStream();let constraints;
  install(async value=>{constraints=value;return stream;});
  const recorder=new VoiceRecorder();await recorder.start();
  assert.equal(constraints.audio.echoCancellation,false);assert.equal(constraints.audio.noiseSuppression,false);assert.equal(constraints.audio.autoGainControl,true);
  assert.equal(recorder.mediaRecorder.mimeType,'audio/mp4');assert.equal(recorder.mediaRecorder.timeslice,1000);
  const a=recorder.stop(),b=recorder.stop();assert.equal(a,b);assert.ok((await a).size);assert.equal(stream.track.stopped,1);
});
test('mobile recorders can reject the bitrate hint without losing the recording',async()=>{
  class MobileRecorder extends FakeRecorder {
    constructor(stream,options){
      if ('audioBitsPerSecond' in options) { const error=new Error('unsupported option');error.name='NotSupportedError';throw error; }
      super(stream,options);
    }
  }
  MobileRecorder.isTypeSupported=()=>true;
  const stream=fakeStream();install(async()=>stream);globalThis.MediaRecorder=MobileRecorder;
  const recorder=new VoiceRecorder();await recorder.start();
  assert.equal(recorder.mediaRecorder.mimeType,'audio/mp4');assert.equal(recorder.mediaRecorder.timeslice,1000);
  assert.ok((await recorder.stop()).size);assert.equal(stream.track.stopped,1);
});
test('closing during mic permission stops the late stream without recording it',async()=>{
  let resolve;const stream=fakeStream();install(()=>new Promise(done=>{resolve=done;}));
  const recorder=new VoiceRecorder();const pending=recorder.start();await recorder.cancel();resolve(stream);
  assert.equal(await pending,false);assert.equal(stream.track.stopped,1);assert.equal(recorder.isRecording,false);
});
test('a cancelled permission request cannot replace a newer recording',async()=>{
  const stale=fakeStream(),fresh=fakeStream();let resolve;let calls=0;
  install(()=>++calls===1?new Promise(done=>{resolve=done;}):Promise.resolve(fresh));
  const recorder=new VoiceRecorder();const first=recorder.start();await recorder.cancel();await recorder.start();resolve(stale);await first;
  assert.equal(recorder.liveStream,fresh);assert.equal(stale.track.stopped,1);await recorder.stop();
});
test('recording auto-stops exactly once and failed permissions can be retried',async()=>{
  const stream=fakeStream();install(async()=>{throw new Error('denied');});const recorder=new VoiceRecorder({maxDurationMs:8});
  await assert.rejects(recorder.start());install(async()=>stream);let callbacks=0;
  await new Promise(async(resolve,reject)=>{try{await recorder.start(blob=>{callbacks++;assert.ok(blob.size);resolve();});}catch(e){reject(e);}});
  assert.equal(callbacks,1);assert.equal(stream.track.stopped,1);assert.equal(recorder.isRecording,false);
});
