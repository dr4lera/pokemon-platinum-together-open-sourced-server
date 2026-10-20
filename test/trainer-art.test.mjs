import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sign} from 'node:crypto';
import {createServer} from 'node:http';
import {Store} from '../store.mjs';
import {TrainerArt,TRAINER_ART_TEMPLATE,validateNativeTrainerPack,normalizeTrainerArt,MAX_TRAINER_ART_PACK_BYTES} from '../trainer-art.mjs';
import {trainerArtClient} from '../trainer-art-client.mjs';
import {newClient,privateKey,proofBytes,b64,sha} from '../identity.mjs';

// Original synthetic envelope, deliberately containing no game art. These
// fixtures test server structural checks, not native frame/palette semantics.
function fixture(){
  const tags=['PAL ','FELD','FRNT','TILE'],bytes=Buffer.alloc(64+12*tags.length+4*tags.length);
  bytes.write('PTTR');bytes.writeUInt16LE(1,4);bytes.writeUInt32LE(bytes.length,8);bytes[13]=Buffer.byteLength(TRAINER_ART_TEMPLATE);bytes.writeUInt16LE(tags.length,14);bytes.write(TRAINER_ART_TEMPLATE,16);
  tags.forEach((tag,i)=>{bytes.write(tag,64+i*12);bytes.writeUInt32LE(64+12*tags.length+i*4,68+i*12);bytes.writeUInt32LE(4,72+i*12);});return bytes;
}
const metadata=(creation='original',version='v1')=>({creation,version,title:'Original example',creator:'Private artist',label:'Example',template:TRAINER_ART_TEMPLATE});
function lab(){
  const dir=mkdtempSync(join(tmpdir(),'pt-trainer-art-')),store=new Store(join(dir,'store.sqlite')),changed=[],keys=[newClient(),newClient()];
  keys.forEach((key,i)=>store.db.prepare('INSERT INTO players(id,name,key) VALUES(?,?,?)').run(i+1,'artist'+i,key.key));
  const hub={dir,store,social:{profileChanged:player=>changed.push(String(player))}},art=new TrainerArt(hub);
  const send=(player,data,pack,patch={})=>{
    const challenge=art.challenge(),raw=Buffer.from(JSON.stringify(data));
    const request={player:String(player),nonce:challenge.nonce,data:raw.toString('base64'),...(pack?{pack:pack.toString('base64')}:{}),sig:sign(null,proofBytes('PT-PRIVATE-TRAINER-ART',b64(challenge.nonce,32,32),sha(raw)),privateKey(b64(keys[player-1].seed,32,32))).toString('base64'),...patch};
    return {request,result:()=>art.request(request)};
  };
  const publish=(player=1,meta=metadata(),select=true,pack=fixture())=>send(player,{action:'import',metadata:meta,select,bytes:pack.length,hash:sha(pack).toString('hex')},pack).result();
  return {dir,store,hub,art,keys,changed,send,publish,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('native PTTR structural validation rejects ZIP, malformed headers, unordered or overlapping sections and hidden bytes',()=>{
  const pack=fixture();assert.deepEqual(validateNativeTrainerPack(pack),pack);
  const mutate=fn=>{const copy=Buffer.from(pack);fn(copy);assert.throws(()=>validateNativeTrainerPack(copy));};
  assert.throws(()=>validateNativeTrainerPack(Buffer.from('PK\x03\x04a ZIP is not PTTR')));
  assert.throws(()=>validateNativeTrainerPack(Buffer.alloc(MAX_TRAINER_ART_PACK_BYTES+1)));
  mutate(b=>b[0]|=128);mutate(b=>b.writeUInt16LE(3,4));mutate(b=>b[6]=1);mutate(b=>b[12]=2);mutate(b=>b[63]=1);
  mutate(b=>b.writeUInt32LE(b.length-1,8));mutate(b=>b.writeUInt16LE(7,14));mutate(b=>b.write('NOPE',64));
  mutate(b=>b.writeUInt32LE(0xffffffff,68));mutate(b=>b.writeUInt32LE(0xffffffff,72));mutate(b=>b.writeUInt32LE(0,72));
  mutate(b=>b.writeUInt32LE(112,80));mutate(b=>b.write('PAL ',76));mutate(b=>b.write('POSE',100));
  const v2=Buffer.from(pack);v2.writeUInt16LE(2,4);v2[6]=2;assert.deepEqual(validateNativeTrainerPack(v2),v2);v2[7]=1;assert.throws(()=>validateNativeTrainerPack(v2));
  assert.throws(()=>normalizeTrainerArt({creation:'../bad',version:'1',template:TRAINER_ART_TEMPLATE,hash:'a'.repeat(64)}));
  assert.throws(()=>normalizeTrainerArt({creation:'safe',version:'1',template:TRAINER_ART_TEMPLATE,hash:'a'.repeat(64),url:'https://elsewhere'}));
});

test('owned signed imports, exact native wear, idempotent fanout, independent clear and restart persistence',()=>{
  const l=lab();try{
    const imported=l.publish();assert.equal(imported.collection.items.length,1);assert.equal(imported.collection.t,'collection');assert.equal(imported.collection.next,null);assert.equal(l.changed.length,1);
    const art=imported.art;assert.deepEqual(l.art.pack(art.hash).bytes,fixture());
    assert.equal(l.art.handle({player:'1'},{t:'unrelated'}),false);
    assert.equal(l.art.handle({player:'1'},{t:'trainer.art',art}),true);assert.equal(l.changed.length,1);
    assert.throws(()=>l.art.handle({player:'2'},{t:'trainer.art',art}),{code:'trainer_art_not_owned'});
    assert.throws(()=>l.art.handle({player:'1'},{t:'trainer.art',art:{...art,hash:'b'.repeat(64)}}),{code:'trainer_art_not_owned'});
    assert.throws(()=>l.art.handle({player:'1'},{t:'trainer.art'}),{code:'bad_trainer_art'});
    l.publish(1,metadata('second'),false);assert.deepEqual(l.art.profile('1'),art,'import without select preserves current appearance');
    l.art.handle({player:'1'},{t:'trainer.art',art:null});assert.equal(l.art.profile('1'),null);assert.equal(l.changed.length,2);
    l.art.handle({player:'1'},{t:'trainer.art',art:null});assert.equal(l.changed.length,2);
    l.store.db.close();l.store.db=new Store(join(l.dir,'store.sqlite')).db;
    const restarted=new TrainerArt(l.hub);assert.equal(restarted.profile('1'),null);assert.equal(restarted.collection('1').items.length,2);
    restarted.handle({player:'1'},{t:'trainer.art',art});assert.deepEqual(new TrainerArt(l.hub).profile('1'),art);
    assert.throws(()=>l.art.pack('../escape'),{code:'bad_trainer_art_hash'});
    assert.throws(()=>l.art.pack('f'.repeat(64)),{code:'trainer_art_pack_not_found'});
  }finally{l.close();}
});

test('publication proves key ownership, binds pack bytes and consumes each nonce once',()=>{
  const l=lab();try{
    const request=l.send(1,{action:'list'});assert.equal(request.result().collection.items.length,0);assert.throws(request.result,{code:'stale_trainer_art_proof'});
    const spoof=l.send(1,{action:'list'},null,{player:'2'});assert.throws(spoof.result,{code:'bad_proof'});
    const pack=fixture(),data={action:'import',metadata:metadata(),select:true,bytes:pack.length,hash:'0'.repeat(64)};
    assert.throws(l.send(1,data,pack).result,{code:'trainer_art_hash_mismatch'});assert.equal(l.art.collection('1').items.length,0);
    const published=l.publish(),revision=published.collection.revision;l.publish();assert.equal(l.art.collection('1').revision,revision,'same import is idempotent');
    assert.throws(()=>l.publish(1,{...metadata(),title:'Changed version metadata'}),{code:'trainer_art_version_conflict'});
    const tampered=Buffer.from(pack);tampered[tampered.length-1]=5;
    assert.throws(l.send(1,{...data,hash:published.art.hash},tampered).result,{code:'trainer_art_hash_mismatch'});
    writeFileSync(join(l.art.dir,published.art.hash+'.pttrainer'),'changed on disk');assert.throws(()=>l.art.pack(published.art.hash),{code:'trainer_art_pack_corrupt'});
  }finally{l.close();}
});

test('versions remain immutable, selected older versions stay visible, and collections are bounded',()=>{
  const l=lab();try{
    const old=l.publish().art;l.publish(1,metadata('original','v2'),false);
    assert.equal(l.art.collection('1').items[0].version.version,'v1');
    l.art.handle({player:'1'},{t:'trainer.art',art:null});assert.equal(l.art.collection('1').items[0].version.version,'v2');
    l.art.handle({player:'1'},{t:'trainer.art',art:old});
    for(let i=2;i<40;i++)l.publish(1,metadata('original','v'+(i+1)),false);
    assert.throws(()=>l.publish(1,metadata('extra')), {code:'trainer_art_collection_full'});
    assert.equal(l.art.entries('1').length,40);assert.equal(l.art.collection('1').items.length,1);
  }finally{l.close();}
});

test('native collection byte limit rolls back a large metadata import and its selection',()=>{
  const l=lab();try{
    let rejected=false;
    for(let i=0;i<40;i++){
      const before=l.art.entries('1').length,old=l.art.profile('1'),fanouts=l.changed.length;
      try{l.publish(1,{...metadata(('c'+i).padEnd(40,'x'),'v'.repeat(40)),title:'t'.repeat(80),creator:'a'.repeat(80),label:'l'.repeat(24)});}
      catch(e){assert.equal(e.code,'trainer_art_collection_too_large');assert.equal(l.art.entries('1').length,before);assert.deepEqual(l.art.profile('1'),old);assert.equal(l.changed.length,fanouts);rejected=true;break;}
    }
    assert.equal(rejected,true);assert.ok(Buffer.byteLength(JSON.stringify(l.art.collection('1')))<=16384);
  }finally{l.close();}
});

test('signed client imports only native packs and pins the private server identity',async()=>{
  const l=lab(),pin='private-server-pin';let wrongPin=false;
  const server=createServer(async(req,res)=>{
    try{
      let result;
      if(req.url==='/private/server-info')result={hub_key:wrongPin?'wrong':pin};
      else if(req.url==='/private/trainer-art/challenge')result=l.art.challenge();
      else if(req.url==='/private/trainer-art'&&req.method==='POST'){const parts=[];for await(const part of req)parts.push(part);result=l.art.request(JSON.parse(Buffer.concat(parts)));}
      else {res.writeHead(404);res.end();return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
    }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.code??'failed'}));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const profile=join(l.dir,'profile.json'),file=join(l.dir,'original.pttrainer'),out=join(l.dir,'result.json');
    writeFileSync(profile,JSON.stringify({...l.keys[0],player_id:'1',hub:'http://127.0.0.1:'+server.address().port,hub_key:pin}));writeFileSync(file,fixture());
    const imported=await trainerArtClient({profile,action:'import',file,metadata:metadata(),out});assert.equal(imported.art.creation,'original');assert.equal(JSON.parse(readFileSync(out)).ok,true);
    assert.equal((await trainerArtClient({profile,action:'clear'})).art,null);assert.equal((await trainerArtClient({profile,action:'list'})).collection.items.length,1);
    wrongPin=true;await assert.rejects(()=>trainerArtClient({profile,action:'list'}),{code:'server_identity_changed'});
    writeFileSync(file,'PK\x03\x04not a native pack');await assert.rejects(()=>trainerArtClient({profile,action:'import',file,metadata:metadata()}),{code:'bad_trainer_art_pack'});
  }finally{await new Promise(resolve=>server.close(resolve));l.close();}
});
