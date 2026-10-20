import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,sign} from 'node:crypto';
import {Hub} from '../hub.mjs';
import {WebSocket} from '../vendor/ws/wrapper.mjs';
import {newClient,privateKey,proofBytes,readToken,issueToken,sha,b64} from '../identity.mjs';
import {lobbyRenewProof} from '../lobby-renew.mjs';
import {communityLinkTail,communityLinkFingerprint,COMMUNITY_LINK_LIMITS as LIMITS} from '../community-link.mjs';
import {TokenBucket,TrafficWindow} from '../elapsed-limits.mjs';
import {parseConfig,exampleConfig} from '../config.mjs';

const fingerprint={build:'community-client-link-test-v1',catalog:'a'.repeat(64),rules:'b'.repeat(64)};
class Client {
  constructor(url){this.ws=new WebSocket(url);this.messages=[];this.waiters=[];this.ws.on('error',()=>{});this.ws.on('message',(bytes,binary)=>{const message=binary?{t:'binary',data:Buffer.from(bytes)}:JSON.parse(bytes);const index=this.waiters.findIndex(w=>w.type===message.t);if(index<0)this.messages.push(message);else{const [waiter]=this.waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message);}});}
  async open(){await new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject);});return this;}
  send(message){this.ws.send(JSON.stringify(message));}
  next(type){const index=this.messages.findIndex(m=>m.t===type);if(index>=0)return Promise.resolve(this.messages.splice(index,1)[0]);return new Promise((resolve,reject)=>{const waiter={type,resolve,timer:setTimeout(()=>{this.waiters=this.waiters.filter(w=>w!==waiter);reject(new Error('Missing '+type+'; queued '+this.messages.map(m=>m.t).join(',')));},3000)};this.waiters.push(waiter);});}
  destroy(){for(const w of this.waiters)clearTimeout(w.timer);this.ws.terminate();}
}
async function fixture(count=2,options={}){
  const dir=mkdtempSync(join(tmpdir(),'community-link-')),hub=new Hub({dir,port:0,log:false,pluginsEnabled:false,communityLinkEnabled:true,...options}),clients=[];
  await hub.start();
  const profiles=[],lobbies=[];
  const add=async(p,build=fingerprint.build)=>{
    const client=await new Client(hub.url.replace('http:','ws:')+'/lobby').open();clients.push(client);
    client.send({t:'lobby.hello',pt:2,token:p.token,build});const challenge=await client.next('challenge');
    client.send({t:'auth',sig:sign(null,proofBytes('PT2-LOBBY',b64(challenge.nonce,32,32),sha(readToken(hub.identity,p.token).bytes)),privateKey(b64(p.seed,32,32))).toString('base64')});await client.next('lobby.ready');return client;
  };
  for(let i=0;i<count;i++){const key=newClient(),p={...key,...hub.enroll('LinkUser'+i,key.key)};hub.store.putTrainer(p.player_id,{name:'Link'+i,look:0,outfit:0,tutorial_done:true,revision:0});profiles.push(p);lobbies.push(await add(p));}
  lobbies[0].send({t:'party.create'});const party=(await lobbies[0].next('party')).party;
  for(let i=1;i<count;i++){lobbies[i].send({t:'party.join',code:party.code});await lobbies[i].next('party');}
  const prepare=async(i,fields={})=>{lobbies[i].send({t:'community.link.prepare',...fingerprint,...fields});return lobbies[i].next('community.link.prepared');};
  const allocate=async(requestId=randomUUID())=>{lobbies[0].send({t:'community.link.open',request_id:requestId});const offers=await Promise.all(lobbies.map(c=>c.next('community.link.offer')));return {offers,requestId};};
  const raw=async()=>{const c=await new Client(hub.url.replace('http:','ws:')+'/community-link').open();clients.push(c);return c;};
  const hello=(c,offer,fields={})=>c.send({t:'community.link.hello',pt:1,ticket:offer.ticket,session:offer.session,epoch:offer.epoch,...fingerprint,...fields});
  const attach=async(i,offer)=>{const c=await raw();hello(c,offer);const challenge=await c.next('community.link.challenge');c.send({t:'auth',sig:sign(null,proofBytes('PT-COMMUNITY-LINK',b64(challenge.nonce,32,32),communityLinkTail(offer)),privateKey(b64(profiles[i].seed,32,32))).toString('base64')});c.ready=await c.next('community.link.ready');return c;};
  const prepared=async()=>{for(let i=0;i<count;i++)await prepare(i);return allocate();};
  const serverPeer=i=>[...hub.connections].find(c=>c.kind==='community-link'&&c.authenticated&&c.player===profiles[i].player_id);
  return {hub,profiles,lobbies,party,add,prepare,allocate,raw,hello,attach,prepared,serverPeer,async close(){for(const c of clients)c.destroy();await hub.close();rmSync(dir,{recursive:true,force:true});}};
}

test('link opt-in config, own fingerprints and combined role are strict',async()=>{
  assert.equal(parseConfig(exampleConfig,tmpdir()).communityLinkEnabled,false);
  assert.equal(parseConfig({...exampleConfig,communityLink:{enabled:true}},tmpdir()).communityLinkEnabled,true);
  for(const communityLink of [{enabled:'true'},{enabled:true,unknown:1}])assert.throws(()=>parseConfig({...exampleConfig,communityLink},tmpdir()),/Server config/);
  for(const fields of [{build:'reference-release'},{build:'community-client-'},{catalog:'A'.repeat(64)},{rules:'x'.repeat(63)}])assert.throws(()=>communityLinkFingerprint({...fingerprint,...fields}));
  for(const options of [{communityLinkEnabled:false},{role:'world'},{role:'inverna'}]){
    const f=await fixture(2,options);try{assert.equal(f.hub.features.community_link,false);f.lobbies[0].send({t:'community.link.prepare',...fingerprint});assert.equal((await f.lobbies[0].next('err')).code,options.role?'link_combined_server_required':'link_disabled');}finally{await f.close();}
  }
});

test('four real authenticated party peers get idempotent tickets, signed joins and authoritative binary senders',async()=>{
  const f=await fixture(4);try{
    const {offers,requestId}=await f.prepared();assert.equal(f.hub.communityLink.sessions.size,1);assert.equal(f.hub.relay.sessions.size,0);assert.equal(f.hub.store.db.prepare('SELECT COUNT(*) AS n FROM relay_worlds').get().n,0);
    assert.equal(new Set(offers.map(o=>o.ticket)).size,4);assert.equal(new Set(offers.map(o=>o.roster[o.seat].mac)).size,4);
    for(let i=0;i<4;i++){assert.equal(offers[i].seat,i);assert.equal(offers[i].player,f.profiles[i].player_id);assert.equal(offers[i].roster.length,4);assert.match(offers[i].roster_hash,/^[a-f0-9]{64}$/);}
    f.lobbies[0].send({t:'community.link.open',request_id:requestId});assert.equal((await f.lobbies[0].next('community.link.offer')).ticket,offers[0].ticket);assert.equal(f.hub.communityLink.tickets.size,4);
    const peers=[];for(let i=0;i<4;i++)peers.push(await f.attach(i,offers[i]));assert.equal(peers[3].ready.active,true);assert.equal(f.hub.communityLink.tickets.size,0);
    for(const peer of peers){let update;do{update=await peer.next('community.link.peers');}while(!update.active);assert.equal(update.connected.length,4);}
    // Seat 2 can be the runtime's DS parent. The server never interprets AIDs.
    peers[2].ws.send(Buffer.from([1,255,0,0x42,0x43]));for(const i of [0,1,3])assert.deepEqual((await peers[i].next('binary')).data,Buffer.from([1,2,0,0x42,0x43]));
    peers[0].ws.send(Buffer.from([1,2,15,9]));assert.deepEqual((await peers[2].next('binary')).data,Buffer.from([1,0,15,9]));
    const replay=await f.raw();f.hello(replay,offers[0]);assert.equal((await replay.next('err')).code,'link_bad_ticket');
    peers[2].ws.close();assert.equal((await peers[0].next('community.link.peer_left')).seat,2);assert.equal((await f.lobbies[0].next('community.link.ended')).reason,'peer_disconnected');assert.equal(f.hub.communityLink.sessions.size,0);
    f.lobbies[0].send({t:'community.link.open',request_id:requestId});assert.equal((await f.lobbies[0].next('err')).code,'link_request_closed');
  }finally{await f.close();}
});

test('unprepared, incompatible, foreign lobby, bad proof, stale epoch and reused tickets fail closed',async()=>{
  const f=await fixture();try{
    f.lobbies[1].send({t:'community.link.open',request_id:randomUUID()});assert.equal((await f.lobbies[1].next('err')).code,'not_leader');
    await f.prepare(0);f.lobbies[0].send({t:'community.link.open',request_id:randomUUID()});assert.equal((await f.lobbies[0].next('err')).code,'link_incompatible_member');
    await f.prepare(1,{catalog:'c'.repeat(64)});f.lobbies[0].send({t:'community.link.open',request_id:randomUUID()});assert.equal((await f.lobbies[0].next('err')).code,'link_incompatible_member');await f.prepare(1);
    const {offers}=await f.allocate();
    const epoch=await f.raw();f.hello(epoch,offers[1],{epoch:offers[1].epoch+1});assert.equal((await epoch.next('err')).code,'link_identity_mismatch');
    const wrong=await f.raw();f.hello(wrong,offers[1]);const challenge=await wrong.next('community.link.challenge');
    wrong.send({t:'auth',sig:sign(null,proofBytes('PT-COMMUNITY-LINK',b64(challenge.nonce,32,32),communityLinkTail(offers[1])),privateKey(b64(f.profiles[0].seed,32,32))).toString('base64')});assert.equal((await wrong.next('err')).code,'bad_proof');
    const replay=await f.raw();f.hello(replay,offers[1]);assert.equal((await replay.next('err')).code,'link_bad_ticket');
    f.lobbies[1].send({t:'community.link.ticket',session:offers[1].session,epoch:offers[1].epoch});const replacement=await f.lobbies[1].next('community.link.offer');assert.notEqual(replacement.ticket,offers[1].ticket);await f.attach(1,replacement);await f.attach(0,offers[0]);
    const other=await f.add(f.profiles[1]);other.send({t:'community.link.cancel'});await other.next('community.link.cancelled');assert.equal(f.hub.communityLink.sessions.size,1,'another lobby cannot cancel the frozen socket');
  }finally{await f.close();}
});

for(const change of ['roster','key','build','lobby','fingerprint','expiry'])test('frozen link ends on '+change+' change',async()=>{
  const f=await fixture();try{
    const {offers}=await f.prepared();await f.attach(0,offers[0]);await f.attach(1,offers[1]);
    if(change==='roster'){f.lobbies[1].send({t:'party.leave'});await f.lobbies[1].next('party');}
    if(change==='key'){f.hub.store.db.prepare('UPDATE players SET key=? WHERE id=?').run(newClient().key,f.profiles[1].player_id);f.hub.communityLink.reconcile();}
    if(change==='build'){[...f.hub.connections].find(c=>c.kind==='lobby'&&c.player===f.profiles[1].player_id).build='community-client-changed';f.hub.communityLink.reconcile();}
    if(change==='lobby')f.lobbies[1].ws.close();
    if(change==='expiry'){[...f.hub.connections].find(c=>c.kind==='lobby'&&c.player===f.profiles[1].player_id).expires=Date.now()-1;f.hub.communityLink.reconcile();}
    if(change==='fingerprint'){f.lobbies[1].send({t:'community.link.prepare',...fingerprint,rules:'d'.repeat(64)});await f.lobbies[1].next('community.link.prepared');}
    await f.lobbies[0].next('community.link.ended');assert.equal(f.hub.communityLink.sessions.size,0);assert.equal(f.hub.communityLink.tickets.size,0);
    const old=await f.raw();f.hello(old,offers[0]);assert.equal((await old.next('err')).code,'link_bad_ticket');
  }finally{await f.close();}
});

for(const kind of ['destination','frame','frame-rate','byte-rate','backpressure'])test('link '+kind+' fault tears down before forwarding',async()=>{
  const f=await fixture();try{
    const {offers}=await f.prepared(),a=await f.attach(0,offers[0]),b=await f.attach(1,offers[1]),server=f.serverPeer(0);
    let expected;
    if(kind==='destination'){expected='link_bad_destination';a.ws.send(Buffer.from([1,3,4]));}
    if(kind==='frame'){expected='link_bad_frame';a.ws.send(Buffer.from([1,255]));}
    if(kind==='frame-rate'){expected='link_rate_limit';server.linkFrames=new TrafficWindow(LIMITS.frames_per_second,Infinity,()=>0);for(let i=0;i<121;i++)a.ws.send(Buffer.from([1,1,4]));}
    if(kind==='byte-rate'){expected='link_rate_limit';server.linkBytes=new TokenBucket(LIMITS.bytes_per_second,LIMITS.burst_bytes,()=>0);for(let i=0;i<33;i++){const frame=Buffer.alloc(8194);frame[0]=1;frame[1]=1;a.ws.send(frame);}}
    if(kind==='backpressure'){expected='link_slow_consumer';Object.defineProperty(f.serverPeer(1).ws,'bufferedAmount',{configurable:true,get:()=>LIMITS.buffered_bytes});a.ws.send(Buffer.from([1,1,4]));}
    assert.equal((await a.next('err')).code,expected);await f.lobbies[0].next('community.link.ended');assert.equal(f.hub.communityLink.sessions.size,0);
    if(['destination','frame','backpressure'].includes(kind))assert.equal(b.messages.some(m=>m.t==='binary'),false);
  }finally{await f.close();}
});

test('pending joins and tickets expire; a new allocation has a fresh epoch',async()=>{
  const f=await fixture();try{
    const first=await f.prepared();const record=f.hub.communityLink.tickets.get(sha(b64(first.offers[0].ticket,32,32)).toString('hex'));record.expires=Date.now()-1;
    const expired=await f.raw();f.hello(expired,first.offers[0]);assert.equal((await expired.next('err')).code,'link_bad_ticket');
    const session=f.hub.communityLink.sessions.get(first.offers[0].session);session.joinDeadline=Date.now()-1;f.hub.communityLink.sweep();assert.equal((await f.lobbies[0].next('community.link.ended')).reason,'join_expired');await f.lobbies[1].next('community.link.ended');
    const second=await f.allocate();assert.notEqual(second.offers[0].session,first.offers[0].session);assert.ok(second.offers[0].epoch>first.offers[0].epoch);
  }finally{await f.close();}
});

test('outsiders cannot allocate, and another account cannot reuse a captured nonce signature',async()=>{
  const f=await fixture(3);try{
    f.lobbies[2].send({t:'party.leave'});await f.lobbies[2].next('party');
    f.lobbies[2].send({t:'community.link.open',request_id:randomUUID()});assert.equal((await f.lobbies[2].next('err')).code,'party_required');
    await f.prepare(0);await f.prepare(1);f.lobbies[0].send({t:'community.link.open',request_id:randomUUID()});
    const offers=await Promise.all(f.lobbies.slice(0,2).map(c=>c.next('community.link.offer')));
    const a=await f.raw(),b=await f.raw();f.hello(a,offers[0]);f.hello(b,offers[1]);const nonce=await a.next('community.link.challenge');await b.next('community.link.challenge');
    const sig=sign(null,proofBytes('PT-COMMUNITY-LINK',b64(nonce.nonce,32,32),communityLinkTail(offers[0])),privateKey(b64(f.profiles[0].seed,32,32))).toString('base64');
    b.send({t:'auth',sig});assert.equal((await b.next('err')).code,'bad_proof');
    a.send({t:'auth',sig});assert.equal((await a.next('community.link.ready')).seat,0);
    // A user cannot start forwarding until the complete immutable roster joins.
    a.ws.send(Buffer.from([1,255,1]));assert.equal((await a.next('err')).code,'link_not_ready');await f.lobbies[0].next('community.link.ended');
  }finally{await f.close();}
});

test('cancel withdraws preparation before allocation and acknowledges without party or session',async()=>{
  const f=await fixture();try{
    await f.prepare(0);await f.prepare(1);
    f.lobbies[1].send({t:'community.link.cancel'});await f.lobbies[1].next('community.link.cancelled');
    f.lobbies[0].send({t:'community.link.open',request_id:randomUUID()});assert.equal((await f.lobbies[0].next('err')).code,'link_incompatible_member');assert.equal(f.hub.communityLink.sessions.size,0);
    f.lobbies[1].send({t:'community.link.cancel'});await f.lobbies[1].next('community.link.cancelled');
    await f.prepare(1);const {offers}=await f.allocate();await f.attach(0,offers[0]);await f.attach(1,offers[1]);
    f.lobbies[1].send({t:'community.link.cancel'});await f.lobbies[1].next('community.link.ended');await f.lobbies[1].next('community.link.cancelled');assert.equal(f.hub.communityLink.sessions.size,0);
    f.lobbies[1].send({t:'party.leave'});await f.lobbies[1].next('party');
    f.lobbies[1].send({t:'community.link.prepare',...fingerprint});await f.lobbies[1].next('community.link.prepared');
    f.lobbies[1].send({t:'community.link.cancel'});await f.lobbies[1].next('community.link.cancelled');
    const lobby=[...f.hub.connections].find(c=>c.kind==='lobby'&&c.player===f.profiles[1].player_id);assert.equal(lobby.communityLinkPrepared,undefined);
  }finally{await f.close();}
});

test('same-key signed lobby renewal preserves a link past old token expiry but never its hard deadline',async()=>{
  const f=await fixture();try{
    // Reauthenticate this disposable guest with a genuinely signed token near
    // expiry, rather than replacing the production renewal or clock functions.
    const closed=new Promise(resolve=>f.lobbies[1].ws.once('close',resolve));
    f.lobbies[1].ws.close();await closed;
    const near=issueToken(f.hub.identity,f.profiles[1].player_id,f.profiles[1].key,Date.now()-3598000);
    f.lobbies[1]=await f.add({...f.profiles[1],...near});
    const {offers}=await f.prepared();await f.attach(0,offers[0]);await f.attach(1,offers[1]);
    const bound=[...f.hub.connections].find(c=>c.kind==='lobby'&&c.player===f.profiles[1].player_id);
    const op=randomUUID();f.lobbies[1].send({t:'auth.renew',op,sig:sign(null,lobbyRenewProof(bound.account.bytes,op),privateKey(b64(f.profiles[1].seed,32,32))).toString('base64')});
    const renewed=await f.lobbies[1].next('auth.renewed');assert.ok(renewed.expires_at_ms>Date.now()+3000000);
    assert.equal(readToken(f.hub.identity,renewed.token).key.toString('base64'),offers[1].key);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,near.expires_at_ms-Date.now()+80)));
    f.hub.communityLink.sweep();
    const session=f.hub.communityLink.sessions.get(offers[0].session);
    assert.ok(session,'current signed same-key lobby renewal must preserve the native link');
    assert.equal(session.expires,offers[0].expires_at_ms);assert.ok(session.expires>Date.now()+1700000);
    assert.equal(f.serverPeer(1).expires,session.expires);
    // Renewal cannot move the independent fixed session deadline or identity.
    session.expires=Date.now()-1;f.hub.communityLink.sweep();
    assert.equal((await f.lobbies[0].next('community.link.ended')).reason,'session_expired');
    assert.equal(f.hub.communityLink.sessions.size,0);
  }finally{await f.close();}
});
