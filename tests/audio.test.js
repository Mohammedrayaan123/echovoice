import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePcmChannels } from '../public/js/audioQuality.js';
import { computeDivergence } from '../public/js/comparisonMath.js';
import { generateFeedbackCards, mapWordsToColors } from '../public/js/comparisonFeedback.js';
const rate = 8000;
const tone = (seconds, amplitude=.15) => Float32Array.from({length:rate*seconds},(_,i)=>amplitude*Math.sin(2*Math.PI*180*i/rate));
test('capture rejects short, silent, overloaded and mostly silent samples',()=>{
  assert.equal(analyzePcmChannels([tone(5)],rate).canCreate,false);
  assert.equal(analyzePcmChannels([new Float32Array(rate*8)],rate).canCreate,false);
  assert.equal(analyzePcmChannels([new Float32Array(rate*8).fill(1)],rate).canCreate,false);
  const gaps = new Float32Array(rate*8); gaps.set(tone(2));
  assert.equal(analyzePcmChannels([gaps],rate).canCreate,false);
});
test('clean 8s audio passes and opposite stereo channels are not mistaken for silence',()=>{
  const clean=tone(8); const opposite=Float32Array.from(clean,x=>-x);
  assert.equal(analyzePcmChannels([clean],rate).canCreate,true);
  const result=analyzePcmChannels([clean,opposite],rate);
  assert.equal(result.canCreate,true);assert.equal(result.activeSeconds,8);
  assert.equal(clean[30],tone(8)[30]);
});
test('invalid samples and inconsistent channels are rejected; quiet audio gets actionable guidance',()=>{
  assert.throws(()=>analyzePcmChannels([Float32Array.of(NaN)],rate));
  assert.throws(()=>analyzePcmChannels([tone(1),tone(2)],rate));
  assert.throws(()=>analyzePcmChannels([tone(1)],0));
  assert.ok(analyzePcmChannels([tone(8,.018)],rate).issues.some(issue=>issue.code==='quiet'));
});
const contour = (hz,start=0,length=2) => Array.from({length:Math.round(length/.01)+1},(_,i)=>({time:start+i*.01,frequency:hz}));
test('pitch comparison respects the two-semitone boundary and rejects insufficient overlap',()=>{
  assert.equal(computeDivergence(contour(180),contour(180)).score,100);
  assert.equal(computeDivergence(contour(180),contour(180*2**(2/12))).score,100);
  assert.equal(computeDivergence(contour(180),contour(180*2**(3/12))).score,0);
  assert.equal(computeDivergence(contour(180),contour(180,3)).score,null);
  assert.equal(computeDivergence(contour(180,0,.1),contour(180,0,.1)).score,null);
  assert.equal(computeDivergence([],[]).score,null);
});
test('uniform pitch matching never invents a weakest section',()=>{
  const result=computeDivergence(contour(180),contour(180));
  const cards=generateFeedbackCards(result);
  assert.ok(!cards.some(card=>card.text.startsWith('Needs work:')));
});
test('word feedback tolerates absent data and uses actual matching reference timings',()=>{
  assert.equal(mapWordsToColors('one two three four five',2,[]).length,5);
  const map=Array.from({length:101},(_,i)=>({time:i*.02,semitones:i<50?0:4}));
  const words='one two three four five'.split(' ');
  const timings=words.map((text,i)=>({text,start:1+i*.1,end:1.05+i*.1}));
  assert.ok(mapWordsToColors(words.join(' '),2,map,timings).every(w=>w.colorVar==='--color-error'));
});
