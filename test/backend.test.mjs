import {adminClient} from '../admin-client.mjs';
import {canonicalIp} from '../moderation.mjs';
import {lobbyRenewProof} from '../lobby-renew.mjs';
import {Social} from '../social.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,rmSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,sign,randomBytes,generateKeyPairSync} from 'node:crypto';
import {mailProof} from '../mail.mjs';
import {inboxClient} from '../inbox-client.mjs';
import {WebSocket} from '../vendor/ws/wrapper.mjs';
import {Hub} from '../hub.mjs';
import {newClient,privateKey,proofBytes,readToken,issueToken,sha,b64} from '../identity.mjs';
import {refreshProof} from '../refresh.mjs';
import {controlBytes} from '../control.mjs';
import {accountBytes} from '../accounts.mjs';
import {accountClient} from '../account-client.mjs';
import {worldsClient} from '../worlds-client.mjs';

class Client {
  constructor(url){this.ws=new WebSocket(url);this.messages=[];this.waiters=[];this.ws.on('message',(b,binary)=>{const m=binary?{t:'binary',data:Buffer.from(b)}:JSON.parse(b);const i=this.waiters.findIndex(w=>w.type===m.t);if(i>=0){const [w]=this.waiters.splice(i,1);clearTimeout(w.timer);w.resolve(m);}else this.messages.push(m);});}
  async open(){await new Promise((resolve,reject)=>{this.ws.once('open',resolve);this.ws.once('error',reject);});return this;}
  send(m){this.ws.send(JSON.stringify(m));}
  next(type){const i=this.messages.findIndex(m=>m.t===type);if(i>=0)return Promise.resolve(this.messages.splice(i,1)[0]);return new Promise((resolve,reject)=>{const w={type,resolve,timer:setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);reject(new Error(`Timed out waiting for ${type}: ${JSON.stringify(this.messages)}`));},3000)};this.waiters.push(w);});}
  close(){this.ws.close();}
}
async function connect(hub,profile,ticket,build='test-015'){
  const c=await new Client(hub.url.replace('http:','ws:')+(ticket?'/realm':'/lobby')).open();
  c.send(ticket?{t:'hello',pt:1,ticket:ticket.ticket,build}:{t:'lobby.hello',pt:2,token:profile.token,build});
  const challenge=await c.next('challenge');const tail=ticket?b64(ticket.ticket,32,32):sha(readToken(hub.identity,profile.token).bytes);
  c.send({t:'auth',sig:sign(null,proofBytes(ticket?'PT-REALM':'PT2-LOBBY',b64(challenge.nonce,32,32),tail),privateKey(b64(profile.seed,32,32))).toString('base64')});
  c.ready=await c.next(ticket?'ready':'lobby.ready');return c;
}
async function ticket(c,realm){c.send({t:'realm.enter',realm});return c.next('realm.ticket');}

test('optional friend codes use authenticated native parties and remain scoped to one server',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-friend-codes-')),hub=new Hub({dir,port:0,log:false,friendCodesEnabled:true}),clients=[];
 try{
  await hub.start();const profiles=['CodeHost','CodeGuest','CodeOther','CodeFourth','CodeFifth'].map(name=>{const key=newClient(),p={...key,...hub.enroll(name,key.key)};hub.store.putTrainer(p.player_id,{name,look:0,outfit:0,tutorial_done:true,revision:0});return {...p,hub:hub.url,hub_key:hub.identity.pin};});
  for(const p of profiles)clients.push(await connect(hub,p));
  assert.equal(clients[0].ready.features.friend_codes,true);
  clients[0].send({t:'private.friend-code.create'});const first=(await clients[0].next('private.friend-code')).invite;
  assert.match(first.code,/^[ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);assert.equal(first.server,hub.url);assert.equal(first.hub_key,hub.identity.pin);
  clients[0].send({t:'private.friend-code.create'});assert.equal((await clients[0].next('private.friend-code')).invite.code,first.code);
  const file=join(dir,'guest.json');writeFileSync(file,JSON.stringify(profiles[1]));
  const joined=await worldsClient({profile:file,action:'friend-code-join',code:'  '+first.code.toLowerCase()+'  '});assert.equal(joined.invite.party,first.party);
  clients[1].send({t:'private.friend-code.create'});assert.equal((await clients[1].next('err')).code,'already_in_party');
  clients[2].send({t:'private.friend-code.join',code:'AAAAA0'});assert.equal((await clients[2].next('err')).code,'bad_party_code');
  for(let i=2;i<4;i++){clients[i].send({t:'private.friend-code.join',code:first.code});assert.equal((await clients[i].next('private.friend-code')).invite.size,i+1);}
  clients[4].send({t:'private.friend-code.join',code:first.code});assert.equal((await clients[4].next('err')).code,'party_full');
  assert.equal(hub.relay.sessions.size,0,'joining does not create a world or consume a relay seat');
  const alien=new Hub({dir:join(dir,'other'),port:0,log:false,friendCodesEnabled:true});try{await alien.start();assert.equal([...alien.social.parties.values()].some(p=>p.code===first.code),false);}finally{await alien.close();}
  for(const p of profiles)hub.social.leave(p.player_id);
  clients[1].send({t:'private.friend-code.join',code:first.code});assert.equal((await clients[1].next('err')).code,'party_not_found');
 }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('friend codes default off without disabling existing native parties',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-codes-off-')),hub=new Hub({dir,port:0,log:false});let c;
 try{await hub.start();const key=newClient(),p={...key,...hub.enroll('CodeDisabled',key.key)};hub.store.putTrainer(p.player_id,{name:'CodeOff',look:0,outfit:0,tutorial_done:true,revision:0});c=await connect(hub,p);
  assert.equal(c.ready.features.friend_codes,false);c.send({t:'private.friend-code.create'});assert.equal((await c.next('err')).code,'friend_codes_disabled');c.send({t:'party.create'});assert.ok((await c.next('party')).party.code);
 }finally{c?.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('Discord invites expire, respect party ownership and require the recipient account to join',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-discord-')),hub=new Hub({dir,port:0,log:false}),clients=[];
 try{
  await hub.start();const address=hub.url;
  const profiles=['InviteHost','InviteGuest'].map(name=>{const key=newClient(),p={...key,...hub.enroll(name,key.key)};hub.store.putTrainer(p.player_id,{name:name.slice(0,10),look:0,outfit:0,tutorial_done:true,revision:0});return p;});
  for(const p of profiles)clients.push(await connect(hub,p));
  clients[0].send({t:'party.create'});const party=(await clients[0].next('party')).party;
  assert.equal(hub.discordInvites.create(profiles[0].player_id),null,'loopback must not be shared');
  hub.url='https://world.example.com';
  clients[0].send({t:'private.discord.invite'});const invite=(await clients[0].next('private.discord.invite')).invite;
  assert.equal(invite.party,party.id);assert.ok(Buffer.byteLength(invite.secret)<=128);
  assert.equal(hub.discordInvites.create(profiles[0].player_id).secret,invite.secret,'reuse until near expiry');
  assert.equal(hub.discordInvites.create(profiles[1].player_id),null);
  const key=invite.secret.split('/').at(-1),resolved=await fetch(address+'/private/j/'+key).then(r=>r.json());
  assert.equal(resolved.code,party.code);assert.equal(resolved.hub_key,hub.identity.pin);
  assert.equal(hub.social.party(profiles[1].player_id),undefined,'resolving never joins or authenticates');
  for(const field of ['seed','token','refresh_token','ticket','key'])assert.equal(Object.hasOwn(resolved,field),false);
  clients[1].send({t:'party.join',code:resolved.code});assert.equal((await clients[1].next('party')).party.id,party.id);
  hub.discordInvites.invites.get(key).expires=Date.now()-1;
  assert.equal((await fetch(address+'/private/j/'+key).then(r=>r.json())).error,'invite_expired');
  const next=hub.discordInvites.create(profiles[0].player_id);assert.notEqual(next.secret,invite.secret);
  hub.social.leave(profiles[0].player_id);assert.throws(()=>hub.discordInvites.resolve(next.secret.split('/').at(-1)),e=>e.code==='invite_expired');
  const successor=hub.discordInvites.create(profiles[1].player_id);assert.notEqual(successor.secret,next.secret);
  assert.equal(hub.discordInvites.resolve(successor.secret.split('/').at(-1)).name,'InviteGuest');
 }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('custom Pokemon, egg and item gifts require the recipient key and acknowledge a bound delivery once',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-mart-'));let hub=new Hub({dir,port:0,log:false});
 try{
  await hub.start();const a=newClient(),b=newClient(),p={...a,...hub.enroll('EggOwner',a.key)},q={...b,...hub.enroll('EggOther',b.key)},path=join(dir,'profile.json');
  writeFileSync(path,JSON.stringify({...p,hub:hub.url,hub_key:hub.identity.pin}));const pgt=Buffer.alloc(260);pgt.writeUInt16LE(3);pgt.writeUInt32LE(467,4);const draft={op:randomUUID(),to:['EggOwner'],title:'Custom gift',body:'Collect from the deliveryman.',attachments:[{kind:'pgt',data:pgt.toString('base64')}]};hub.mail.publish(draft);
  const gifts=(await inboxClient({profile:path,action:'list'})).gifts;assert.equal(gifts.length,1);assert.equal(Buffer.from(gifts[0].data,'base64').readUInt32LE(4),467);assert.equal(hub.mail.list(p.player_id)[0].attachments.length,0);
  const stolen=join(dir,'stolen.json');writeFileSync(stolen,JSON.stringify({...p,seed:b.seed,hub:hub.url,hub_key:hub.identity.pin}));await assert.rejects(()=>inboxClient({profile:stolen,action:'list'}),/bad_proof/);
  const id=gifts[0].id,client='a'.repeat(64);await assert.rejects(()=>inboxClient({profile:path,action:'ack',id,client}),/gift_not_prepared/);
  const ready=await inboxClient({profile:path,action:'prepare',id,client});assert.equal(ready.data,pgt.toString('base64'));await assert.rejects(()=>inboxClient({profile:path,action:'prepare',id,client:'b'.repeat(64)}),/gift_reserved/);
  await hub.close();hub=new Hub({dir,port:0,log:false});await hub.start();writeFileSync(path,JSON.stringify({...p,hub:hub.url,hub_key:hub.identity.pin}));assert.equal((await inboxClient({profile:path,action:'prepare',id,client})).data,pgt.toString('base64'));
  assert.equal((await inboxClient({profile:path,action:'ack',id,client})).acknowledged,true);assert.equal((await inboxClient({profile:path,action:'ack',id,client})).acknowledged,true);assert.equal((await inboxClient({profile:path,action:'list'})).gifts.length,0);
 }finally{await hub.close();rmSync(dir,{recursive:true,force:true});}
});

for(const build of ['test-015','b113ab54d7b0e9a690c51e87'])test(`native relay ${build}: ready contract, nonce proof, replay refusal and routing`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-relay-')),hub=new Hub({dir,port:0,log:false}),clients=[];
  try{
    await hub.start();const profiles=['RelayHost','RelayGuest','Outside'].map(name=>{const key=newClient();const p={...key,...hub.enroll(name,key.key)};hub.store.putTrainer(p.player_id,{name:name.slice(0,10),look:0,outfit:0,tutorial_done:true,revision:0});return p;});
    for(const p of profiles)clients.push(await connect(hub,p,undefined,build));
    assert.equal(clients[0].ready.features.player_worlds,true,'combined backend exposes the verified manual relay join path');
    clients[0].send({t:'party.invite',player:profiles[1].player_id});const invite=await clients[1].next('party.invited');await clients[0].next('party.invite.sent');clients[1].send({t:'party.join',party:invite.party});await clients[1].next('party');
    clients[2].send({t:'party.world.join',request_id:randomUUID()});assert.equal((await clients[2].next('err')).code,'party_required');
    clients[0].send({t:'party.world.join',request_id:randomUUID()});const host=await clients[0].next('party.world'),guest=await clients[1].next('party.world');assert.equal(host.session,guest.session);assert.equal(host.seat,0);assert.equal(guest.seat,1);assert.equal(host.asked_by,null);assert.equal(guest.asked_by,null);
    async function join(p,t){
      const c=await new Client(hub.url.replace('http:','ws:')+'/relay').open();clients.push(c);
      c.send({t:'hello',pt:1,ticket:t.ticket,build});const challenge=await c.next('challenge');
      c.send({t:'auth',sig:sign(null,b64(challenge.nonce,32,32),privateKey(b64(p.seed,32,32))).toString('base64')});
      const ready=await c.next('ready');
      assert.equal(ready.world,t.world);assert.equal(ready.session,t.session);assert.equal(ready.seat,t.seat);
      assert.ok(Number.isSafeInteger(ready.epoch)&&ready.epoch>=0);
      assert.ok(Array.isArray(ready.roster)&&ready.roster.some(r=>r.seat===t.seat&&r.player_id===p.player_id));
      const bounds={game_frames_per_second:[1,1000],game_bytes_per_second:[1024,491640],game_burst_bytes:[1024,491640]};
      for(const [key,[min,max]] of Object.entries(bounds))assert.ok(Number.isInteger(ready.limits[key])&&ready.limits[key]>=min&&ready.limits[key]<=max,`native 0.1.7 rejects ready limit ${key}`);
      return c;
    }
    const a=await join(profiles[0],host);
    const mismatch=await new Client(hub.url.replace('http:','ws:')+'/relay').open();clients.push(mismatch);
    mismatch.send({t:'hello',pt:1,ticket:guest.ticket,build:'incompatible-build'});assert.equal((await mismatch.next('err')).code,'version');
    const b=await join(profiles[1],guest);
    a.ws.send(Buffer.from([1,255,7,8,9]));assert.deepEqual((await b.next('binary')).data,Buffer.from([1,0,7,8,9]));
    b.ws.send(Buffer.from([1,0,10,11]));assert.deepEqual((await a.next('binary')).data,Buffer.from([1,1,10,11]));
    const replay=await new Client(hub.url.replace('http:','ws:')+'/relay').open();clients.push(replay);replay.send({t:'hello',pt:1,ticket:host.ticket,build});assert.equal((await replay.next('err')).code,'bad_ticket');
    b.ws.send(Buffer.from([1,9,1]));assert.equal((await b.next('err')).code,'bad_game_frame');
    clients[1].send({t:'party.leave'});await clients[1].next('party');assert.equal([...hub.relay.sessions.values()][0].players[1],null);
  }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('invites in Inverna cannot allocate the city as a home world; normal return unlocks the visit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-city-return-')),hub=new Hub({dir,port:0,log:false}),clients=[];
 try{await hub.start();const profiles=['CityHost','CityGuest'].map(name=>{const key=newClient(),p={...key,...hub.enroll(name,key.key)};hub.store.putTrainer(p.player_id,{name,look:0,outfit:0,tutorial_done:true,revision:0});return p;});
  for(const p of profiles)clients.push(await connect(hub,p));const [host,guest]=clients;
  host.send({t:'city.enter',district:'plaza'});await host.next('city.joined');host.send({t:'party.create'});const party=(await host.next('party')).party;
  guest.send({t:'party.join',code:party.code});await guest.next('party');guest.send({t:'party.world.join',request_id:randomUUID()});assert.equal((await guest.next('err')).code,'host_in_city');assert.equal(hub.relay.sessions.size,0);assert.equal(hub.relay.tickets.size,0);
  host.send({t:'city.leave'});await host.next('city.left');assert.equal(hub.social.party(profiles[1].player_id).id,party.id,'return retains the invited party');
  guest.send({t:'party.world.join',request_id:randomUUID()});const a=await host.next('party.world'),b=await guest.next('party.world');assert.equal(a.session,b.session);assert.equal(a.seat,0);assert.equal(b.seat,1);
 }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('owner-key mail publication, recipient isolation, idempotency and durable claim recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-mail-'));let hub=new Hub({dir,port:0,log:false});const clients=[];
  try{
    await hub.start();const a=newClient(),b=newClient(),p={...a,...hub.enroll('MailOwner',a.key)},q={...b,...hub.enroll('MailFriend',b.key)};
    const sender=generateKeyPairSync('rsa',{modulusLength:3072});writeFileSync(join(dir,'mail-sender-public.pem'),sender.publicKey.export({type:'spki',format:'pem'}));
    const request=async(data,key=sender.privateKey)=>{const challenge=await fetch(hub.url+'/private/mail/challenge').then(r=>r.json());const encoded=Buffer.from(JSON.stringify(data)).toString('base64');const m={...challenge,data:encoded,sig:sign('sha256',mailProof(challenge.nonce,challenge.server_ms,encoded),key).toString('base64')};const response=await fetch(hub.url+'/private/mail',{method:'POST',body:JSON.stringify(m)});return {response,body:await response.json(),m};};
    const draft={action:'send',op:randomUUID(),to:['MailFriend'],title:'Welcome',body:'A private gift.',attachments:[{kind:'item',item:'poke-ball',count:5}]};
    assert.throws(()=>hub.mail.challenge({socket:{remoteAddress:'192.0.2.1'}}),e=>e.code==='local_control_only');
    const wrong=generateKeyPairSync('rsa',{modulusLength:2048});assert.equal((await request(draft,wrong.privateKey)).body.error,'bad_mail_proof');
    const sent=await request(draft);assert.equal(sent.body.delivered,1);assert.equal((await fetch(hub.url+'/private/mail',{method:'POST',body:JSON.stringify(sent.m)})).status,400);
    assert.equal((await request(draft)).body.delivered,1);assert.equal((await request({...draft,title:'Changed'})).body.error,'mail_op_conflict');
    assert.equal((await request({...draft,op:randomUUID(),to:['MailFriend','Missing']})).body.error,'recipient_not_found');assert.equal(hub.mail.list(q.player_id).length,1);
    const owner=await connect(hub,p),friend=await connect(hub,q);clients.push(owner,friend);owner.send({t:'mail.list'});assert.equal((await owner.next('mail.letters')).letters.length,0);
    friend.send({t:'mail.list'});const letter=(await friend.next('mail.letters')).letters[0],grant=letter.attachments[0].grant;
    owner.send({t:'mail.prepare',grant,box:'box-a'});assert.equal((await owner.next('mail.refused')).code,'not_found');
    friend.send({t:'mail.ack',grant,box:'box-a'});assert.equal((await friend.next('mail.refused')).code,'not_prepared');
    friend.send({t:'mail.prepare',grant,box:'box-a'});assert.equal((await friend.next('mail.prepared')).payload.count,5);
    for(const c of clients)c.ws.terminate();clients.length=0;await hub.close();hub=new Hub({dir,port:0,log:false});await hub.start();
    const recovered=await connect(hub,q);clients.push(recovered);recovered.send({t:'mail.prepare',grant,box:'box-b'});assert.equal((await recovered.next('mail.refused')).code,'reserved');
    recovered.send({t:'mail.prepare',grant,box:'box-a'});assert.equal((await recovered.next('mail.prepared')).payload.count,5);
    for(let i=0;i<2;i++){recovered.send({t:'mail.ack',grant,box:'box-a'});assert.equal((await recovered.next('mail.acked')).grant,grant);}
    recovered.send({t:'mail.prepare',grant,box:'box-a'});assert.equal((await recovered.next('mail.refused')).code,'acknowledged');
    recovered.send({t:'mail.read',letter:letter.letter});assert.equal((await recovered.next('mail.letters')).letters[0].read,true);
  }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});
test('real HTTP/WebSocket auth, membership, chunk integrity and persistence across backend restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-private-'));let hub=new Hub({dir,port:0,log:false});let clients=[];
  try{
    await hub.start();const own=newClient(),friend=newClient(),stranger=newClient();const p={...own,...hub.enroll('Owner',own.key)},f={...friend,...hub.enroll('Friend',friend.key)},s={...stranger,...hub.enroll('Stranger',stranger.key)};
    const health=await fetch(hub.url+'/health').then(r=>r.json());assert.equal(health.dedicated_simulation,false);
    const a=await connect(hub,p);clients.push(a);a.send({t:'realm.create',name:'Test World'});const realm=(await a.next('realm')).realm.realm;
    a.send({t:'realm.invite',realm,player:f.player_id});await a.next('realm');
    const outside=await connect(hub,s);clients.push(outside);outside.send({t:'realm.enter',realm});assert.equal((await outside.next('err')).code,'not_a_member');
    const r=await connect(hub,p,await ticket(a,realm));clients.push(r);assert.equal(r.ready.seat,0);assert.equal(r.ready.save,null);
    r.send({t:'world.publish',setup:Buffer.from('test setup').toString('base64'),story:[[1,12]],rival:null});assert.deepEqual((await r.next('world')).story.values,[[1,12]]);
    const data=randomBytes(10123),hash=sha(data).toString('hex'),op=randomUUID();
    r.send({t:'save.begin',op,counter:1,size:data.length,hash});assert.equal((await r.next('save.go')).chunk,4096);
    for(let i=0;i<3;i++)r.send({t:'save.chunk',op,index:i,data:data.subarray(i*4096,(i+1)*4096).toString('base64')});
    r.send({t:'save.commit',op});assert.equal((await r.next('save.ack')).hash,hash);
    const bad=randomUUID();r.send({t:'save.begin',op:bad,counter:2,size:4,hash:'0'.repeat(64)});await r.next('save.go');r.send({t:'save.chunk',op:bad,index:0,data:'dGVzdA=='});r.send({t:'save.commit',op:bad});assert.equal((await r.next('err')).code,'bad_save_hash');assert.equal(hub.store.latest(realm).counter,1);
    const pin=hub.identity.pin;for(const c of clients)c.close();clients=[];await hub.close();
    hub=new Hub({dir,port:0,log:false});await hub.start();assert.equal(hub.identity.pin,pin);
    const b=await connect(hub,f);clients.push(b);const rejoined=await connect(hub,f,await ticket(b,realm));clients.push(rejoined);assert.equal(rejoined.ready.seat,1);assert.equal(rejoined.ready.save.hash,hash);assert.deepEqual(rejoined.ready.story.values,[[1,12]]);
    rejoined.send({t:'save.get'});const pieces=[];for(let i=0;i<3;i++)pieces.push(Buffer.from((await rejoined.next('save.data')).data,'base64'));const end=await rejoined.next('save.end');assert.equal(end.hash,hash);assert.deepEqual(Buffer.concat(pieces),data);
    rejoined.send({t:'invented.success'});assert.equal((await rejoined.next('err')).code,'unsupported_message');
  }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});
test('token forgery, expiry, malformed base64 and unauthenticated commands are rejected',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-private-'));const hub=new Hub({dir,port:0,log:false});let c;
  try{
    await hub.start();const identity=newClient(),p=hub.enroll('Tester',identity.key),t=readToken(hub.identity,p.token);
    assert.equal(t.player,p.player_id);assert.throws(()=>readToken(hub.identity,p.token,Date.now()+3600001));
    const envelope=JSON.parse(Buffer.from(p.token,'base64'));const raw=Buffer.from(envelope.bytes,'base64');raw[2]^=1;envelope.bytes=raw.toString('base64');assert.throws(()=>readToken(hub.identity,Buffer.from(JSON.stringify(envelope)).toString('base64')));
    c=await new Client(hub.url.replace('http:','ws:')+'/lobby').open();c.send({t:'realm.create',name:'No auth'});assert.equal((await c.next('err')).code,'version');assert.equal(hub.store.db.prepare('SELECT COUNT(*) n FROM realms').get().n,0);
  }finally{c?.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('native-shaped city presence, targeted invites, consent, capacity and party leadership',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-social-'));const hub=new Hub({dir,port:0,log:false});const clients=[];
  try{
    await hub.start();const identities=Array.from({length:5},()=>newClient());const profiles=identities.map((i,n)=>({...i,...hub.enroll('Trainer'+n,i.key)}));
    for(let n=0;n<5;n++){const c=await connect(hub,profiles[n]);clients.push(c);c.send({t:'trainer.put',name:'Trainer'+n,look:0,outfit:0,tutorial_done:true,revision:0});assert.equal((await c.next('trainer')).applied,true);}
    clients[0].send({t:'city.enter',district:'plaza'});assert.equal((await clients[0].next('city.joined')).players.length,0);
    clients[1].send({t:'city.enter',district:'plaza'});const city=await clients[1].next('city.joined');assert.equal(city.players[0].player,profiles[0].player_id);assert.equal((await clients[0].next('city.add')).player,profiles[1].player_id);
    // Captured native 0.1.7 frame: spatial cells 7,32 and an eight-byte position.
    // Neither cell byte may become an authenticated player identity.
    clients[1].ws.send(Buffer.from('020720e00a903004010000','hex'));assert.deepEqual((await clients[0].next('binary')).data,Buffer.from([2,1,city.slot,8,0xe0,0x0a,0x90,0x30,4,1,0,0]));
    clients[1].ws.send(Buffer.from([2,63,255,1,2,3,4,5,6,7,8]));assert.deepEqual((await clients[0].next('binary')).data,Buffer.from([2,1,city.slot,8,1,2,3,4,5,6,7,8]));
    clients[1].ws.send(Buffer.from([2,0,32,10]));assert.equal((await clients[1].next('err')).code,'bad_city_frame');
    clients[0].send({t:'party.invite',player:profiles[1].player_id});const invite=await clients[1].next('party.invited');await clients[0].next('party.invite.sent');
    clients[2].send({t:'party.join',party:invite.party});assert.equal((await clients[2].next('err')).code,'invite_expired');
    clients[1].send({t:'party.join',party:invite.party});assert.equal((await clients[1].next('party')).party.members.length,2);
    clients[1].send({t:'party.invite',player:profiles[2].player_id});assert.equal((await clients[1].next('err')).code,'not_leader');
    for(let n=2;n<4;n++){clients[0].send({t:'party.invite',player:profiles[n].player_id});const i=await clients[n].next('party.invited');await clients[0].next('party.invite.sent');clients[n].send({t:'party.join',party:i.party});assert.equal((await clients[n].next('party')).party.members.length,n+1);}
    clients[0].send({t:'party.invite',player:profiles[4].player_id});assert.equal((await clients[0].next('err')).code,'party_full');
    clients[0].messages=clients[0].messages.filter(m=>m.t!=='party');clients[0].send({t:'party.leave'});assert.equal((await clients[0].next('party')).party,null);
    assert.equal(hub.social.party(profiles[1].player_id).leader,profiles[1].player_id);
    clients[1].send({t:'city.leave'});await clients[1].next('city.left');assert.equal((await clients[0].next('city.drop')).slot,city.slot);
  }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('native trainer appearance updates omit name and preserve creation identity with revision conflicts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-native-trainer-')),hub=new Hub({dir,port:0,log:false});let c;
 try{await hub.start();const key=newClient(),p={...key,...hub.enroll('NativeLook',key.key)};c=await connect(hub,p);
  c.send({t:'trainer.put',look:8,outfit:0,tutorial_done:true,revision:0});assert.equal((await c.next('err')).code,'bad_text');
  c.send({t:'trainer.put',name:'LabHost',look:0,outfit:0,tutorial_done:false,revision:0});const initial=(await c.next('trainer')).trainer;
  c.send({t:'trainer.put',look:8,outfit:0,tutorial_done:true,revision:1});const updated=await c.next('trainer');
  assert.equal(updated.applied,true);assert.equal(updated.trainer.name,'LabHost');assert.equal(updated.trainer.revision,2);assert.equal(updated.trainer.created_at_ms,initial.created_at_ms);assert.equal(updated.trainer.look,8);
  c.send({t:'trainer.put',look:9,outfit:2,tutorial_done:false,revision:1});const stale=await c.next('trainer');assert.equal(stale.applied,false);assert.deepEqual(stale.trainer,updated.trainer);
  c.send({t:'trainer.put',name:null,look:9,outfit:2,tutorial_done:true,revision:2});assert.equal((await c.next('err')).code,'bad_text');assert.deepEqual(hub.store.trainer(p.player_id),updated.trainer);
 }finally{c?.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('chosen trainer appearance and native-valid names update peers already in Inverna',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-live-look-')),hub=new Hub({dir,port:0,log:false}),clients=[];
 try{await hub.start();const file=join(dir,'account.json');await accountClient('register',{url:hub.url,name:'New_Name',out:file});const owner=JSON.parse(readFileSync(file));
  assert.equal(hub.store.trainer(owner.player_id).name,'New Name');
  const key=newClient(),guest={...key,...hub.enroll('LookPeer',key.key)};hub.store.putTrainer(guest.player_id,{name:'LookPeer',look:0,outfit:0,tutorial_done:true,revision:0});
  const a=await connect(hub,owner),b=await connect(hub,guest);clients.push(a,b);
  for(const c of clients){c.send({t:'city.enter',district:'plaza'});await c.next('city.joined');}await a.next('city.add');
  a.send({t:'trainer.put',name:"O'Neil",look:7,outfit:123,tutorial_done:true,revision:1});const update=await a.next('trainer'),peer=await b.next('city.add');
  assert.equal(update.applied,true);assert.equal(peer.player,owner.player_id);assert.equal(peer.name,"O'Neil");assert.equal(peer.look,7);assert.equal(peer.outfit,123);assert.equal(peer.slot,0);
  a.ws.send(Buffer.from('020720e00ab03004010000','hex'));assert.equal((await b.next('binary')).data[2],0,'appearance updates retain the same authenticated position slot');
  a.send({t:'trainer.put',name:'Invalid_',look:7,outfit:123,tutorial_done:true,revision:2});assert.equal((await a.next('err')).code,'name_refused');assert.equal(hub.store.trainer(owner.player_id).name,"O'Neil");
 }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('friends require consent, resolve stable usernames, persist and can be removed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-friends-'));let hub=new Hub({dir,port:0,log:false});let clients=[];
  try{
    await hub.start();const keys=[newClient(),newClient(),newClient()];const profiles=keys.map((k,n)=>({...k,...hub.enroll(['Alice','Bobby','Carol'][n],k.key)}));
    assert.throws(()=>hub.enroll('alice',newClient().key),/username_taken/);
    for(const p of profiles)clients.push(await connect(hub,p));const [a,b,c]=clients;
    c.send({t:'friend.answer',username:'Alice',accept:true});assert.equal((await c.next('err')).code,'request_not_found');
    a.send({t:'friend.add',username:'bObBy'});assert.equal((await b.next('friend.request')).from,'Alice');assert.deepEqual((await a.next('social')).requests_out,['Bobby']);assert.deepEqual((await b.next('social')).requests_in,['Alice']);
    assert.equal(hub.friends.peers(profiles[0].player_id).length,0);
    b.send({t:'friend.answer',username:'Alice',accept:true});assert.equal((await a.next('social')).friends[0].username,'Bobby');assert.equal((await b.next('social')).friends[0].username,'Alice');
    for(const c of clients)c.ws.terminate();clients=[];await hub.close();hub=new Hub({dir,port:0,log:false});await hub.start();
    const again=await connect(hub,profiles[0]);clients.push(again);again.send({t:'social.get'});const snapshot=await again.next('social');assert.equal(snapshot.friends[0].username,'Bobby');assert.equal(snapshot.friends[0].online,false);
    again.send({t:'friend.remove',username:'Bobby'});assert.equal((await again.next('social')).friends.length,0);assert.equal(hub.friends.peers(profiles[1].player_id).length,0);
  }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('native refresh rotates credentials, rejects forged proof and safely repeats a lost response',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-refresh-'));const hub=new Hub({dir,port:0,log:false});
  try{
    await hub.start();const key=newClient(),profile=hub.enroll('RenewTrainer',key.key),proof=refreshProof(profile.refresh_token);
    assert.equal(proof.bytes.length,60);assert.equal(proof.bytes.subarray(0,12).toString(),'PT2-REFRESH\0');
    const request={refresh_token:profile.refresh_token,op:proof.op,sig:sign(null,proof.bytes,privateKey(b64(key.seed,32,32))).toString('base64')};
    const post=m=>fetch(hub.url+'/auth/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});
    assert.equal((await post({...request,sig:randomBytes(64).toString('base64')})).status,400);
    const response=await post(request);assert.equal(response.status,200);const credentials=await response.json();assert.notEqual(credentials.refresh_token,profile.refresh_token);assert.equal(readToken(hub.identity,credentials.token).player,profile.player_id);
    assert.deepEqual(await (await post(request)).json(),credentials);
    assert.equal((await post({...request,op:randomUUID()})).status,400);
    assert.equal(hub.store.db.prepare('SELECT 1 FROM refresh WHERE hash=?').get(sha(profile.refresh_token).toString('hex')),undefined);
  }finally{await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('chat history, subscriptions, idempotent sends, channel isolation and restart recovery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-chat-'));let hub=new Hub({dir,port:0,log:false});let clients=[];
  try{
    await hub.start();const keys=[newClient(),newClient()];const profiles=keys.map((k,n)=>({...k,...hub.enroll('Chatter'+n,k.key)}));
    const a=await connect(hub,profiles[0]),b=await connect(hub,profiles[1]);clients=[a,b];
    a.send({t:'chat.join',channel:'global'});assert.equal((await a.next('chat')).msgs.length,0);b.send({t:'chat.join',channel:'lang.en'});await b.next('chat');
    const message={t:'chat.send',channel:'global',text:'Local integration test',op:randomUUID()};a.send(message);const first=await a.next('chat.new');assert.equal(first.msg.from,'Chatter0');
    a.send(message);assert.equal((await a.next('chat.new')).msg.id,first.msg.id);assert.equal(hub.store.db.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,1);
    a.send({...message,text:'Changed text'});assert.equal((await a.next('err')).code,'op_conflict');
    b.send({t:'chat.get',channel:'lang.en',before:0,limit:50});assert.equal((await b.next('chat')).msgs.length,0);assert.equal(b.messages.some(m=>m.t==='chat.new'),false);
    b.send({t:'chat.get',channel:'guild'});assert.equal((await b.next('err')).code,'unsupported_channel');
    a.send({t:'chat.read',channel:'global',upto:first.msg.id});assert.equal((await a.next('chat')).read_upto,first.msg.id);
    for(const c of clients)c.ws.terminate();clients=[];await hub.close();hub=new Hub({dir,port:0,log:false});await hub.start();
    const again=await connect(hub,profiles[0]);clients.push(again);again.send({t:'chat.get',channel:'global'});const history=await again.next('chat');assert.equal(history.msgs[0].text,message.text);assert.equal(history.read_upto,first.msg.id);
  }finally{for(const c of clients)c.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown requires the local server owner and a fresh signed challenge',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-control-'));const hub=new Hub({dir,port:0,log:false});
  try{
    await hub.start();const owner=newClient(),guest=newClient();hub.enroll('Owner',owner.key);hub.enroll('Guest',guest.key);
    const challenge=await fetch(hub.url+'/private/control/challenge').then(r=>r.json());
    const make=(key,player)=>({action:'shutdown',player,...challenge,sig:sign(null,controlBytes(b64(challenge.nonce,32,32),challenge.server_ms),privateKey(b64(key.seed,32,32))).toString('base64')});
    const post=m=>fetch(hub.url+'/private/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});
    assert.equal((await post(make(guest,'2'))).status,400);assert.equal((await post(make(guest,'1'))).status,400);
    const response=await post(make(owner,'1'));assert.equal(response.status,200);assert.equal((await response.json()).ok,true);await hub.close();await hub.close();
  }finally{await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('private accounts reserve unique names, require their own key, rename safely and recover lost registration responses',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pt-accounts-'));let hub=new Hub({dir,port:0,log:false});
  try{
    await hub.start();const file=join(dir,'account.json'),second=join(dir,'second.json');
    const created=await accountClient('register',{url:hub.url,name:'ChosenName',out:file});assert.equal(created.username,'ChosenName');
    const profile=JSON.parse(readFileSync(file));assert.equal(hub.store.trainer(profile.player_id).name,'ChosenName');
    await assert.rejects(()=>accountClient('register',{url:hub.url,name:'chosenname',out:second}),/username_taken/);
    const thief=newClient(),post=(path,m)=>fetch(hub.url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});
    const request={action:'rename',key:profile.key,username:'StolenName'};const challenge=await (await post('/auth/account/challenge',request)).json();
    const forged={...request,nonce:challenge.nonce,sig:sign(null,accountBytes('rename',b64(challenge.nonce,32,32),profile.key,'StolenName'),privateKey(b64(thief.seed,32,32))).toString('base64')};assert.equal((await post('/auth/account',forged)).status,400);assert.equal(hub.store.player(profile.player_id).name,'ChosenName');
    const login=await accountClient('login',{profile:file});assert.equal(login.player,created.player);
    const renamed=await accountClient('rename',{profile:file,name:'NewName'});assert.equal(renamed.player,created.player);assert.equal(renamed.username,'NewName');assert.equal(hub.store.trainer(profile.player_id).name,'NewName');
    await accountClient('register',{url:hub.url,name:'OtherName',out:second});await assert.rejects(()=>accountClient('rename',{profile:second,name:'NEWNAME'}),/username_taken/);
    // Simulate receiving the server commit but losing the local result file.
    const current=JSON.parse(readFileSync(file));writeFileSync(file+'.pending',JSON.stringify({seed:current.seed,key:current.key,hub:hub.url,hub_key:current.hub_key}));unlinkSync(file);
    const recovered=await accountClient('register',{url:hub.url,name:'NewName',out:file});assert.equal(recovered.player,created.player);
    await hub.close();hub=new Hub({dir,port:0,log:false});await hub.start();assert.equal(hub.store.player(created.player).name,'NewName');assert.equal(hub.store.db.prepare('SELECT COUNT(*) n FROM players WHERE lower(name)=?').get('newname').n,1);
  }finally{await hub.close();rmSync(dir,{recursive:true,force:true});}
});


test('party codes match the native client character restrictions',()=>{
 const fake={store:{trainer:()=>({name:'Test',look:0,outfit:0})}};
 const social=new Social(fake);
 const codes=new Set();
 for(let i=0;i<200;i++){const code=social.create(String(i)).code;assert.match(code,/^[A-HJKMNP-Z2-9]{6}$/);assert.ok(!codes.has(code));codes.add(code);}
});


test('native code joins use code field and preserve party consent',()=>{
 // Joining a party does not create the native client's pending world request.
 // An unsolicited allocation here is ignored by guests and must not be mistaken
 // for a completed world join, even with player_worlds enabled for a fixture.
 const sent=[];const fake={features:{player_worlds:true},relay:{allocate:()=>assert.fail('party membership allocated a world without a client request')},store:{trainer:()=>({name:'Test',look:0,outfit:0})},connections:[],send:(_,m)=>sent.push(m)};
 const social=new Social(fake);social.update=()=>{};const p=social.create('1');
 assert.throws(()=>social.handle({player:'2'},{t:'party.join',code:'000000'}),e=>e.code==='bad_party_code');
 assert.throws(()=>social.handle({player:'2'},{t:'party.join',code:p.code,party:p.id}),e=>e.code==='bad_party_code');
 social.handle({player:'2'},{t:'party.join',code:p.code});assert.deepEqual(p.members,['1','2']);
 social.handle({player:'2'},{t:'party.join',code:p.code});assert.deepEqual(p.members,['1','2']);
 assert.throws(()=>social.handle({player:'3'},{t:'party.join',party:p.id}),e=>e.code==='invite_expired');
});


test('native lobby renewal verifies possession, refuses another key and repeats lost acknowledgements',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-renew-')),hub=new Hub({dir,port:0,log:false});let c;
 try {await hub.start();const a=newClient(),b=newClient(),p={...a,...hub.enroll('RenewOne',a.key)};c=await connect(hub,p);
 const op=randomUUID(),proof=lobbyRenewProof(readToken(hub.identity,p.token).bytes,op),sig=sign(null,proof,privateKey(b64(a.seed,32,32))).toString('base64');
 c.send({t:'auth.renew',op,sig:sign(null,proof,privateKey(b64(b.seed,32,32))).toString('base64')});assert.equal((await c.next('err')).code,'bad_proof');
 c.send({t:'auth.renew',op,sig});const r=await c.next('auth.renewed');assert.equal(readToken(hub.identity,r.token).player,p.player_id);
 c.send({t:'auth.renew',op,sig});assert.deepEqual(await c.next('auth.renewed'),r);
 c.send({t:'ping',ts:123});assert.equal((await c.next('pong')).ts,123);
 }finally{c?.close();await hub.close();rmSync(dir,{recursive:true,force:true});}
});


test('owner-only bans disconnect users, survive restart, normalize IPs and retain local recovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-bans-'));let hub=new Hub({dir,port:0,log:false}),guest;
 try{
 await hub.start();const a=newClient(),b=newClient(),p={...a,...hub.enroll('BanOwner',a.key)},q={...b,...hub.enroll('BanGuest',b.key)};
 for(const profile of [p,q])hub.store.putTrainer(profile.player_id,{name:profile.display_name.slice(0,10),look:0,outfit:0,tutorial_done:true,revision:0});
 const file=join(dir,'owner.json');const saveProfile=()=>writeFileSync(file,JSON.stringify({...p,hub:hub.url,hub_key:hub.identity.pin}));saveProfile();
 guest=await connect(hub,q);const closed=new Promise(resolve=>guest.ws.once('close',resolve));
 const result=await adminClient({profile:file,action:'ban-user',target:'banguest',reason:'Test'});assert.equal(result.disconnected,1);await closed;
 assert.throws(()=>hub.credentials(q.player_id),e=>e.code==='user_banned');
 // Public friends/profile metadata remains readable after a ban.
 assert.equal(hub.store.playerInfo(q.player_id).name,'BanGuest');
 await hub.close();hub=new Hub({dir,port:0,log:false});await hub.start();saveProfile();
 assert.equal((await adminClient({profile:file,action:'list-bans'})).bans.length,1);
 await adminClient({profile:file,action:'unban-user',target:'BanGuest'});guest=await connect(hub,q);guest.ws.terminate();
 await assert.rejects(()=>adminClient({profile:file,action:'ban-user',target:'BanOwner'}),/cannot_ban_server_owner/);
 assert.equal(canonicalIp('::ffff:127.0.0.1'),'127.0.0.1');assert.equal(canonicalIp('2001:0db8:0:0::1'),'2001:db8::1');
 await adminClient({profile:file,action:'ban-ip',target:'::ffff:127.0.0.1',reason:'Loopback fixture'});
 assert.equal((await fetch(hub.url+'/health')).status,403);
 await assert.rejects(()=>new Client(hub.url.replace('http:','ws:')+'/lobby').open(),/403/);
 await adminClient({profile:file,action:'unban-ip',target:'127.0.0.1'});assert.equal((await fetch(hub.url+'/health')).status,200);
 const bad=join(dir,'guest.json');writeFileSync(bad,JSON.stringify({...q,hub:hub.url,hub_key:hub.identity.pin}));
 await assert.rejects(()=>adminClient({profile:bad,action:'ban-user',target:'BanOwner'}),/not_server_owner/);
 }finally{guest?.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});


test('relay IP bans trust only explicitly enabled loopback proxy headers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-proxy-')),hub=new Hub({dir,port:0,log:false});
 try{await hub.start();const a=newClient(),p={...a,...hub.enroll('ProxyOwner',a.key)},file=join(dir,'owner.json');writeFileSync(file,JSON.stringify({...p,hub:hub.url,hub_key:hub.identity.pin}));
 await adminClient({profile:file,action:'ban-ip',target:'198.51.100.9'});
 const options={headers:{'CF-Connecting-IP':'198.51.100.9'}};
 assert.equal((await fetch(hub.url+'/health',options)).status,200);
 await adminClient({profile:file,action:'proxy-local',target:'on'});assert.equal((await fetch(hub.url+'/health',options)).status,403);
 assert.equal(hub.moderation.address({socket:{remoteAddress:'192.0.2.8'},headers:{'cf-connecting-ip':'198.51.100.9'}}),'192.0.2.8');
 await adminClient({profile:file,action:'proxy-local',target:'off'});assert.equal((await fetch(hub.url+'/health',options)).status,200);
 }finally{await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('local plugins handle authenticated calls, isolate hangs and reload without stopping the server',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-plugins-')),hub=new Hub({dir,port:0,log:false});let c;
 const install=(id,code,enabled=true,entry='main.mjs')=>{const folder=join(dir,'Plugins',id);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'plugin.json'),JSON.stringify({id,version:'1.0.0',entry,enabled}));writeFileSync(join(folder,'main.mjs'),code);};
 install('echo',"export async function onEvent(e){if(e.type==='call')return {echo:e.data.args,player:e.data.player,keys:Object.keys(e.data).sort()};}");
 install('hang',"export function onEvent(e){if(e.type==='call')while(true){};}");
 install('disabled',"throw new Error('Must not import');",false);
 install('escape','',true,'../outside.mjs');
 try{await hub.start();const a=newClient(),p={...a,...hub.enroll('PluginOwner',a.key)},file=join(dir,'owner.json');writeFileSync(file,JSON.stringify({...p,hub:hub.url,hub_key:hub.identity.pin}));
 c=await connect(hub,p);const op=randomUUID();c.send({t:'plugin.call',plugin:'echo',op,args:{hello:'world'}});const r=await c.next('plugin.result');assert.equal(r.op,op);assert.deepEqual(r.data.echo,{hello:'world'});assert.deepEqual(r.data.keys,['args','player','username']);
 const list=(await adminClient({profile:file,action:'plugins-list'})).plugins;assert.equal(list.find(x=>x.id==='disabled').state,'disabled');assert.equal(list.find(x=>x.id==='escape').state,'failed');
 c.send({t:'plugin.call',plugin:'hang',op:randomUUID()});assert.equal((await fetch(hub.url+'/health')).status,200);assert.equal((await c.next('err')).code,'plugin_timeout');
 assert.equal((await adminClient({profile:file,action:'plugins-list'})).plugins.find(x=>x.id==='hang').state,'failed');
 install('hang',"export function onEvent(e){if(e.type==='call')return {fixed:true};}");
 await adminClient({profile:file,action:'plugins-reload'});c.send({t:'plugin.call',plugin:'hang',op:randomUUID()});assert.equal((await c.next('plugin.result')).data.fixed,true);
 c.send({t:'ping',ts:99});assert.equal((await c.next('pong')).ts,99);
 }finally{c?.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});


test('plugins use the existing native chat command flow with private durable replies and no duplicate execution',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-plugin-chat-')),folder=join(dir,'Plugins','greet');mkdirSync(folder,{recursive:true});
 writeFileSync(join(folder,'plugin.json'),JSON.stringify({id:'greet',version:'1.0.0',enabled:true,entry:'main.mjs'}));
 writeFileSync(join(folder,'main.mjs'),"let count=0;export function onEvent(e){if(e.type==='command')return {reply:'Hello '+e.data.args+' #'+(++count)};}");
 const hub=new Hub({dir,port:0,log:false});let a,b;
 try{await hub.start();const p=newClient(),q=newClient();a=await connect(hub,{...p,...hub.enroll('CmdOwner',p.key)});b=await connect(hub,{...q,...hub.enroll('CmdGuest',q.key)});
 for(const c of [a,b]){c.send({t:'chat.join',channel:'global'});await c.next('chat');}
 const command={t:'chat.send',channel:'global',op:randomUUID(),text:'/greet world'};a.send(command);assert.equal((await a.next('chat.new')).msg.text,command.text);
 const reply=(await a.next('chat.new')).msg;assert.equal(reply.kind,'system');assert.equal(reply.text,'[greet] Hello world #1');assert.equal(b.messages.filter(m=>m.t==='chat.new').length,0);
 a.send(command);await a.next('chat.new');assert.equal((await a.next('chat.new')).msg.id,reply.id);
 b.send({t:'chat.get',channel:'global'});assert.equal((await b.next('chat')).msgs.length,0);
 a.send({t:'chat.get',channel:'global'});assert.equal((await a.next('chat')).msgs.length,2);
 }finally{a?.ws.terminate();b?.ws.terminate();await hub.close();rmSync(dir,{recursive:true,force:true});}
});


test('joined worlds record authenticated entry, isolate players and persist across restarts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-world-list-'));let hub=new Hub({dir,port:0,log:false});const clients=[];
 try{
  await hub.start();const a=newClient(),b=newClient(),d=newClient();
  const owner={...a,...hub.enroll('ListOwner',a.key)},guest={...b,...hub.enroll('ListGuest',b.key)},other={...d,...hub.enroll('ListOther',d.key)};
  const file=join(dir,'guest.json');const saveProfile=()=>writeFileSync(file,JSON.stringify({...guest,hub:hub.url,hub_key:hub.identity.pin}));saveProfile();
  const r=hub.store.create(owner.player_id,'A real world');hub.store.invite(String(r.id),owner.player_id,guest.player_id);
  assert.deepEqual((await worldsClient({profile:file})).worlds,[]);
  const lobby=await connect(hub,guest);clients.push(lobby);const entry=await ticket(lobby,String(r.id));
  assert.deepEqual(hub.store.joinedWorlds(guest.player_id),[]);
  const realm=await connect(hub,guest,entry);clients.push(realm);
  const listed=await worldsClient({profile:file});assert.equal(listed.worlds.length,1);assert.equal(listed.worlds[0].name,'A real world');assert.equal(listed.worlds[0].owner_name,'ListOwner');
  assert.deepEqual(hub.store.joinedWorlds(other.player_id),[]);
  for(const c of clients)c.close();await hub.close();hub=new Hub({dir,port:0,log:false});await hub.start();saveProfile();
  assert.equal((await worldsClient({profile:file})).worlds[0].world,String(r.id));
  hub.store.db.prepare('DELETE FROM members WHERE realm=? AND player=?').run(r.id,guest.player_id);
  assert.deepEqual((await worldsClient({profile:file})).worlds,[]);
 }finally{for(const c of clients)c.close();await hub.close();rmSync(dir,{recursive:true,force:true});}
});

test('Inverna and world hosting roles expose and enforce their own protocol features',async()=>{
 for(const role of ['inverna','world']){
  const dir=mkdtempSync(join(tmpdir(),'pt-role-'));const hub=new Hub({dir,port:0,role,log:false});let c;
  try{
   await hub.start();const key=newClient(),p={...key,...hub.enroll('RoleOwner',key.key)};c=await connect(hub,p);
   assert.equal(c.ready.features.city,role==='inverna');assert.equal(c.ready.features.realms,role==='world');assert.equal(c.ready.features.player_worlds,false);
   c.send(role==='inverna'?{t:'realm.create',name:'Refused'}:{t:'city.enter',district:'plaza'});
   assert.equal((await c.next('err')).code,role==='inverna'?'world_server_required':'inverna_server_required');
  }finally{c?.close();await hub.close();rmSync(dir,{recursive:true,force:true});}
 }
});
