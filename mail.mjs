import {randomBytes,randomUUID,createPublicKey,verify} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {b64,sha,fail} from './identity.mjs';
import {integer} from './store.mjs';

export const MAIL_ITEMS=['ultra-ball','great-ball','poke-ball','net-ball','nest-ball','luxury-ball','premier-ball','dusk-ball','quick-ball','potion','antidote','parlyz-heal','super-potion','full-heal'];
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.-]{1,39}$/.test(v)?v:fail('bad_mail_id');
const prose=(v,max,empty=false)=>typeof v==='string'&&v.length<=max&&(empty||v.trim())&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(v)?v:fail('bad_mail_text');
export const mailProof=(nonce,at,data)=>Buffer.concat([Buffer.from('PT-PRIVATE-MAIL\0'),b64(nonce,32,32),Buffer.from(String(at)+'\0'),sha(b64(data,12000))]);
export class Mail {
  constructor(hub){this.hub=hub;this.nonces=new Map();hub.store.db.exec(`
    CREATE TABLE IF NOT EXISTS mail_operations(op TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mail_letters(id TEXT PRIMARY KEY,player INTEGER NOT NULL REFERENCES players(id),campaign TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,sent INTEGER NOT NULL,read INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS mail_grants(id TEXT PRIMARY KEY,letter TEXT NOT NULL REFERENCES mail_letters(id),payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'available',box TEXT);
    CREATE INDEX IF NOT EXISTS mail_recipient ON mail_letters(player,sent);
  `);}
  challenge(req){this.hub.control.local(req);const now=Date.now();for(const[k,v]of this.nonces)if(v<now)this.nonces.delete(k);if(this.nonces.size>=32)fail('busy');const nonce=randomBytes(32).toString('base64');this.nonces.set(nonce,now+15000);return {nonce,server_ms:now};}
  admin(req,m){
    this.hub.control.local(req);const until=this.nonces.get(m.nonce);if(!until||until<Date.now()||!Number.isSafeInteger(m.server_ms)||Math.abs(Date.now()-m.server_ms)>30000)fail('stale_mail_proof');
    const path=join(this.hub.dir,'mail-sender-public.pem');if(!existsSync(path))fail('mail_sender_not_enrolled');
    const key=createPublicKey(readFileSync(path));if(!verify('sha256',mailProof(m.nonce,m.server_ms,m.data),key,b64(m.sig,512)))fail('bad_mail_proof');this.nonces.delete(m.nonce);
    const data=JSON.parse(b64(m.data,12000).toString());if(data.action==='recipients')return {players:this.hub.store.db.prepare('SELECT name FROM players WHERE disabled=0 ORDER BY lower(name)').all().map(p=>p.name)};
    if(data.action!=='send')fail('unsupported_mail_action');return this.publish(data);
  }
  publish(m){
    const op=id(m.op),title=prose(m.title,40),body=prose(m.body,240,true),campaign=id(m.campaign??op);
    if(!Array.isArray(m.to)||m.to.length<1||m.to.length>128||!Array.isArray(m.attachments)||m.attachments.length>8)fail('bad_mail_delivery');
    const payloads=m.attachments.map(p=>{if(!p||typeof p!=='object')fail('bad_gift');const kind=p.kind;if(kind==='pgt')return {kind,data:this.hub.customGifts.validate(p.data)};let max;if(kind==='item'){if(!MAIL_ITEMS.includes(p.item))fail('unsupported_mail_item');max=999;}else if(kind==='money')max=999999;else if(kind==='boots'||kind==='egg')max=1;else if(kind==='lure')max=99;else fail('unsupported_gift');integer(p.count,1,max);return {kind,...(kind==='item'?{item:p.item}:{}),count:p.count,origin:'standard'};});
    const digest=sha(JSON.stringify({op,title,body,campaign,to:m.to,attachments:payloads})).toString('hex');
    return this.hub.store.tx(()=>{
      const old=this.hub.store.db.prepare('SELECT * FROM mail_operations WHERE op=?').get(op);if(old){if(old.hash!==digest)fail('mail_op_conflict');return JSON.parse(old.result);}
      const targets=[...new Set(m.to.map(n=>{if(typeof n!=='string')fail('bad_recipient');const p=this.hub.store.db.prepare('SELECT id FROM players WHERE lower(name)=lower(?) AND disabled=0').get(n);if(!p)fail('recipient_not_found');return String(p.id);}))];
      for(const player of targets){if(this.hub.store.db.prepare('SELECT count(*) n FROM mail_letters WHERE player=?').get(player).n>=64)fail('mailbox_full');const letter=randomUUID();this.hub.store.db.prepare('INSERT INTO mail_letters(id,player,campaign,title,body,sent) VALUES(?,?,?,?,?,?)').run(letter,player,campaign,title,body,Date.now());for(const p of payloads){if(p.kind==='pgt')this.hub.customGifts.add(letter,p.data);else this.hub.store.db.prepare('INSERT INTO mail_grants(id,letter,payload) VALUES(?,?,?)').run(randomUUID(),letter,JSON.stringify(p));}}
      for(const player of targets)if(Buffer.byteLength(JSON.stringify({t:'mail.letters',letters:this.list(player)}))>15000)fail('mailbox_full');
      const result={ok:true,op,delivered:targets.length};this.hub.store.db.prepare('INSERT INTO mail_operations VALUES(?,?,?)').run(op,digest,JSON.stringify(result));this.hub.log('mail_published',{op,recipients:targets.length,gifts:payloads.length});return result;
    });
  }
  list(player){return this.hub.store.db.prepare('SELECT * FROM mail_letters WHERE player=? ORDER BY sent DESC,id DESC LIMIT 64').all(player).map(l=>({letter:l.id,campaign:l.campaign,title:l.title,body:l.body,sent_at_ms:l.sent,read:!!l.read,archived:false,attachments:this.hub.store.db.prepare('SELECT * FROM mail_grants WHERE letter=? ORDER BY rowid').all(l.id).map(g=>{const {origin,...p}=JSON.parse(g.payload);return {grant:g.id,...p,state:g.state,min_build:0};})}));}
  handle(c,m){
    if(!m.t.startsWith('mail.'))return false;
    if(m.t==='mail.list'){this.hub.send(c,{t:'mail.letters',letters:this.list(c.player)});return true;}
    if(m.t==='mail.read'){this.hub.store.db.prepare('UPDATE mail_letters SET read=1 WHERE id=? AND player=?').run(id(m.letter),c.player);this.hub.send(c,{t:'mail.letters',letters:this.list(c.player)});return true;}
    if(!['mail.prepare','mail.ack'].includes(m.t))fail('unsupported_message');
    const grant=id(m.grant),box=id(m.box);const result=this.hub.store.tx(()=>{
      const g=this.hub.store.db.prepare('SELECT g.* FROM mail_grants g JOIN mail_letters l ON l.id=g.letter WHERE g.id=? AND l.player=?').get(grant,c.player);
      const refused=code=>({t:'mail.refused',grant,code});if(!g)return refused('not_found');if(g.box&&g.box!==box)return refused('reserved');
      if(m.t==='mail.ack'){if(g.state==='available')return refused('not_prepared');this.hub.store.db.prepare("UPDATE mail_grants SET state='acknowledged' WHERE id=?").run(grant);return {t:'mail.acked',grant};}
      if(g.state==='acknowledged')return refused('acknowledged');
      this.hub.store.db.prepare("UPDATE mail_grants SET state='reserved',box=? WHERE id=?").run(box,grant);return {t:'mail.prepared',grant,payload:JSON.parse(g.payload)};
    });this.hub.send(c,result);return true;
  }
}
