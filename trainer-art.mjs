import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {b64,sha,checkProof,fail} from './identity.mjs';

export const MAX_TRAINER_ART_PACK_BYTES=2*1024*1024;
export const MAX_TRAINER_ART_REQUEST_BYTES=Math.ceil(MAX_TRAINER_ART_PACK_BYTES/3)*4+16384;
export const TRAINER_ART_TEMPLATE='platinum-trainer-209-v1';
const DOMAIN='PT-PRIVATE-TRAINER-ART';
const tags=['PAL ','FELD','POSE','FRNT','BIG ','TILE'];
const required=new Set(['PAL ','FELD','FRNT','TILE']);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,40}$/.test(value);
const hashOK=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const safe=(value,max)=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=max&&!/[\x00-\x1f\x7f]/.test(value);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const playerId=value=>{const s=String(value);if(!/^[1-9][0-9]{0,18}$/.test(s))fail('bad_trainer_art_player');return s;};

// The native profile accepts exactly these four fields. No URLs or file paths
// supplied by a client enter either the published profile or the filesystem.
export function normalizeTrainerArt(value){
  if(value===null)return null;
  if(!exact(value,['creation','version','template','hash'])||!id(value.creation)||!id(value.version)||value.template!==TRAINER_ART_TEMPLATE||!hashOK(value.hash))fail('bad_trainer_art');
  return {creation:value.creation,version:value.version,template:value.template,hash:value.hash};
}

// Structural PTTR validation, based on the installed native format. This is not
// a ZIP converter. Pixel, palette, pose and frame semantics are additionally
// validated by the native installer; this server does not claim to audit them.
export function validateNativeTrainerPack(input){
  const bytes=Buffer.from(input);
  if(bytes.length<64||bytes.length>MAX_TRAINER_ART_PACK_BYTES||!bytes.subarray(0,4).equals(Buffer.from('PTTR')))fail('bad_trainer_art_pack');
  const version=bytes.readUInt16LE(4),count=bytes.readUInt16LE(14),length=bytes[13];
  if(![1,2].includes(version)||bytes.readUInt32LE(8)!==bytes.length||bytes[12]>1||length<1||length>47||count<1||count>6||64+count*12>bytes.length)fail('bad_trainer_art_pack');
  if((version===1&&bytes.readUInt16LE(6)!==0)||(version===2&&(bytes[6]>2||bytes[7]!==0)))fail('bad_trainer_art_pack');
  if(bytes.toString('utf8',16,16+length)!==TRAINER_ART_TEMPLATE||bytes.subarray(16+length,64).some(x=>x!==0))fail('unsupported_trainer_art_template');
  let end=64+12*count,last=-1;const seen=new Set();
  for(let i=0;i<count;i++){
    const at=64+12*i,tag=bytes.toString('latin1',at,at+4),index=tags.indexOf(tag),offset=bytes.readUInt32LE(at+4),size=bytes.readUInt32LE(at+8);
    if(index<=last||offset!==end||size===0||offset>bytes.length||size>bytes.length-offset)fail('bad_trainer_art_sections');
    last=index;end=offset+size;seen.add(tag);
  }
  if(end!==bytes.length||[...required].some(tag=>!seen.has(tag)))fail('bad_trainer_art_sections');
  return bytes;
}

export class TrainerArt {
  constructor(hub){
    this.hub=hub;this.nonces=new Map();this.dir=join(hub.dir,'TrainerArt');mkdirSync(this.dir,{recursive:true});
    hub.store.db.exec(`CREATE TABLE IF NOT EXISTS trainer_art_entries(
      player INTEGER NOT NULL REFERENCES players(id),creation TEXT NOT NULL,version TEXT NOT NULL,template TEXT NOT NULL,hash TEXT NOT NULL,
      title TEXT NOT NULL,creator TEXT NOT NULL,label TEXT NOT NULL,bytes INTEGER NOT NULL,at_ms INTEGER NOT NULL,
      PRIMARY KEY(player,creation,version));
      CREATE TABLE IF NOT EXISTS trainer_art_state(player INTEGER PRIMARY KEY REFERENCES players(id),art TEXT,revision INTEGER NOT NULL DEFAULT 1);`);
  }
  state(player){return this.hub.store.db.prepare('SELECT art,revision FROM trainer_art_state WHERE player=?').get(player);}
  profile(player){const row=this.state(playerId(player));return row?.art?JSON.parse(row.art):null;}
  entries(player){return this.hub.store.db.prepare('SELECT rowid,* FROM trainer_art_entries WHERE player=? ORDER BY rowid DESC').all(player);}
  owned(player,art){return this.hub.store.db.prepare('SELECT * FROM trainer_art_entries WHERE player=? AND creation=? AND version=? AND template=? AND hash=?').get(player,art.creation,art.version,art.template,art.hash);}
  bump(player){this.hub.store.db.prepare('INSERT INTO trainer_art_state(player,revision) VALUES(?,2) ON CONFLICT(player) DO UPDATE SET revision=revision+1').run(player);}
  select(player,value){
    player=playerId(player);const art=normalizeTrainerArt(value);
    if(art&&!this.owned(player,art))fail('trainer_art_not_owned');
    if(JSON.stringify(this.profile(player))===JSON.stringify(art))return false;
    this.hub.store.db.prepare('INSERT INTO trainer_art_state(player,art,revision) VALUES(?,?,2) ON CONFLICT(player) DO UPDATE SET art=excluded.art,revision=revision+1').run(player,art?JSON.stringify(art):null);
    return true;
  }
  handle(c,m){
    if(m.t!=='trainer.art')return false;
    if(!Object.hasOwn(m,'art'))fail('bad_trainer_art');
    if(this.select(c.player,m.art))this.hub.social.profileChanged(c.player);
    return true;
  }
  collection(value){
    const player=playerId(value);this.hub.store.player(player);
    const selected=this.profile(player),current=new Map();
    for(const row of this.entries(player))if(!current.has(row.creation)||selected?.creation===row.creation&&selected.version===row.version)current.set(row.creation,row);
    return {t:'collection',revision:this.state(player)?.revision??1,synced_ms:Date.now(),items:[...current.values()].map(row=>({creation:row.creation,title:row.title,creator:row.creator,state:'ready',version:{creation:row.creation,version:row.version,template:row.template,hash:row.hash},label:row.label,bytes:row.bytes})),next:null};
  }
  pack(hash){
    if(!hashOK(hash))fail('bad_trainer_art_hash');
    if(!this.hub.store.db.prepare('SELECT 1 FROM trainer_art_entries WHERE hash=? LIMIT 1').get(hash))fail('trainer_art_pack_not_found');
    let bytes;try{bytes=readFileSync(join(this.dir,hash+'.pttrainer'));}catch{fail('trainer_art_pack_not_found');}
    if(bytes.length>MAX_TRAINER_ART_PACK_BYTES||sha(bytes).toString('hex')!==hash)fail('trainer_art_pack_corrupt');
    return {bytes,contentType:'application/octet-stream'};
  }
  challenge(){
    const now=Date.now();for(const [key,expires]of this.nonces)if(expires<now)this.nonces.delete(key);
    if(this.nonces.size>=1024)fail('busy');const nonce=randomBytes(32).toString('base64');this.nonces.set(nonce,now+15000);return {nonce};
  }
  request(m){
    const expires=this.nonces.get(m.nonce);if(!expires||expires<Date.now())fail('stale_trainer_art_proof');
    const player=playerId(m.player),owner=this.hub.store.player(player),raw=b64(m.data,8192);
    checkProof(b64(owner.key,32,32),DOMAIN,b64(m.nonce,32,32),sha(raw),m.sig);this.nonces.delete(m.nonce);
    let data;try{data=JSON.parse(raw.toString('utf8'));}catch{fail('bad_trainer_art_request');}
    if(!data||typeof data!=='object'||Array.isArray(data))fail('bad_trainer_art_request');
    if(data.action==='list')return {ok:true,art:this.profile(player),collection:this.collection(player)};
    if(data.action==='clear'||data.action==='select'){
      const changed=this.select(player,data.action==='clear'?null:data.art);if(changed)this.hub.social.profileChanged(player);
      return {ok:true,art:this.profile(player)};
    }
    if(data.action!=='import'||!exact(data.metadata,['creation','version','title','creator','label','template'])||!safe(data.metadata.title,80)||!safe(data.metadata.creator,80)||!safe(data.metadata.label,24)||typeof data.select!=='boolean'||!Number.isSafeInteger(data.bytes))fail('bad_trainer_art_request');
    const meta=data.metadata,art=normalizeTrainerArt({creation:meta.creation,version:meta.version,template:meta.template,hash:data.hash});
    const bytes=validateNativeTrainerPack(b64(m.pack,MAX_TRAINER_ART_PACK_BYTES));
    if(data.bytes!==bytes.length||sha(bytes).toString('hex')!==art.hash)fail('trainer_art_hash_mismatch');
    let changed=false;
    this.hub.store.tx(()=>{
      const old=this.hub.store.db.prepare('SELECT * FROM trainer_art_entries WHERE player=? AND creation=? AND version=?').get(player,art.creation,art.version);
      if(old&&(old.hash!==art.hash||old.template!==art.template||old.title!==meta.title||old.creator!==meta.creator||old.label!==meta.label))fail('trainer_art_version_conflict');
      if(!old&&this.entries(player).length>=40)fail('trainer_art_collection_full');
      if(!old){this.hub.store.db.prepare('INSERT INTO trainer_art_entries(player,creation,version,template,hash,title,creator,label,bytes,at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run(player,art.creation,art.version,art.template,art.hash,meta.title,meta.creator,meta.label,bytes.length,Date.now());this.bump(player);}
      if(data.select)changed=this.select(player,art);
      if(Buffer.byteLength(JSON.stringify(this.collection(player)))>16384)fail('trainer_art_collection_too_large');
      const path=join(this.dir,art.hash+'.pttrainer');
      try{writeFileSync(path,bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(sha(readFileSync(path)).toString('hex')!==art.hash)fail('trainer_art_pack_corrupt');}
    });
    if(changed)this.hub.social.profileChanged(player);
    return {ok:true,art:this.profile(player),collection:this.collection(player)};
  }
}
