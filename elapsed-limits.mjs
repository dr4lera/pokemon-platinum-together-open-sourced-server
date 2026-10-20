import {performance} from 'node:perf_hooks';

// Elapsed-time limits use a monotonic clock. UTC is only for protocol timestamps
// and persisted expiry, never for refilling a network traffic budget.
export class TokenBucket {
  constructor(rate,capacity,clock=()=>performance.now()) {
    this.rate=rate;this.capacity=capacity;this.clock=clock;
    this.tokens=capacity;this.updated=clock();
  }
  allow(bytes) {
    if(!Number.isSafeInteger(bytes)||bytes<0)return false;
    const now=Math.max(this.updated,this.clock());
    this.tokens=Math.min(this.capacity,this.tokens+(now-this.updated)*this.rate/1000);
    this.updated=now;
    if(bytes>this.tokens)return false;
    this.tokens-=bytes;return true;
  }
}

export class TrafficWindow {
  constructor(messages,bytes,clock=()=>performance.now()) {
    this.maxMessages=messages;this.maxBytes=bytes;this.clock=clock;
    this.started=clock();this.messages=0;this.bytes=0;
  }
  allow(bytes) {
    if(!Number.isSafeInteger(bytes)||bytes<0)return false;
    const now=this.clock();
    if(now-this.started>=1000){this.started=now;this.messages=0;this.bytes=0;}
    return ++this.messages<=this.maxMessages&&(this.bytes+=bytes)<=this.maxBytes;
  }
}
