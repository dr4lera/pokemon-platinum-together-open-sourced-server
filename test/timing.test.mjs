import test from 'node:test';
import assert from 'node:assert/strict';
import {TokenBucket,TrafficWindow} from '../elapsed-limits.mjs';

test('traffic windows work at clock zero and reset on elapsed time only',()=>{
  let now=0;const window=new TrafficWindow(2,10,()=>now);
  assert.equal(window.allow(5),true);assert.equal(window.allow(5),true);
  assert.equal(window.allow(1),false);
  now=999;assert.equal(window.allow(0),false);
  now=1000;assert.equal(window.allow(10),true);
  assert.equal(window.allow(1),false);
  now=-1000;assert.equal(window.allow(0),false);
});

test('byte refill uses seconds, caps stall catch-up and cannot mint credit on a backward clock',()=>{
  let now=0;const bucket=new TokenBucket(100,200,()=>now);
  assert.equal(bucket.allow(200),true);assert.equal(bucket.allow(1),false);
  now=500;assert.equal(bucket.allow(50),true);
  now=400;assert.equal(bucket.allow(1),false);
  now=500;assert.equal(bucket.allow(1),false);
  now=600;assert.equal(bucket.allow(10),true);
  now=1e9;assert.equal(bucket.allow(201),false);assert.equal(bucket.allow(200),true);
  assert.equal(bucket.allow(-1),false);assert.equal(bucket.allow(NaN),false);
});

test('refill amount is independent of timer/presentation callback frequency',()=>{
  for(const fps of [30,60,120,144]){
    let now=0;const bucket=new TokenBucket(100,1000,()=>now);bucket.allow(1000);
    for(let i=1;i<=fps;i++){now=i*1000/fps;bucket.allow(0);}
    assert.ok(Math.abs(bucket.tokens-100)<1e-8,`refill at ${fps} Hz`);
  }
});
