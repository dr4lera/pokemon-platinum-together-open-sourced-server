import {randomUUID,randomBytes} from 'node:crypto';
import {b64,sha,checkProof,fail} from './identity.mjs';
export const inboxBytes=(nonce,data)=>Buffer.concat([Buffer.from('PT-PRIVATE-INBOX\0'),nonce,sha(data)]);
export class CustomGifts {
  constructor(hub){this.hub=hub;this.nonces=new Map();hub.store.db.exec("CREATE TABLE IF NOT EXISTS mail_custom_grants(id TEXT PRIMARY KEY,letter TEXT NOT NULL REFERENCES mail_letters(id),data TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'available',client TEXT)");}
  challenge(){const now=Date.now();for(const[k,v]of this.nonces)if(v<now)this.nonces.delete(k);if(this.nonces.size>=1024)fail('busy');const nonce=randomBytes(32).toString('base64');this.nonces.set(nonce,now+15000);return {nonce};}
  validate(data){const pgt=b64(data,260,260),type=pgt.readUInt16LE(0);if(type<1||type>3)fail('unsupported_mart_gift');if(type===3&&(pgt.readUInt32LE(4)<1||pgt.readUInt32LE(4)>467))fail('unsupported_mart_item');return data;}
  add(letter,data){this.validate(data);this.hub.store.db.prepare('INSERT INTO mail_custom_grants(id,letter,data) VALUES(?,?,?)').run(randomUUID(),letter,data);}
  request(m){
    const expires=this.nonces.get(m.nonce);if(!expires||expires<Date.now())fail('stale_inbox_proof');const raw=b64(m.data,4096),p=this.hub.store.player(m.player);
    checkProof(b64(p.key,32,32),'PT-PRIVATE-INBOX',b64(m.nonce,32,32),sha(raw),m.sig);this.nonces.delete(m.nonce);const d=JSON.parse(raw.toString());
    if(d.action==='list')return {gifts:this.hub.store.db.prepare("SELECT g.id,g.state,l.title,g.data FROM mail_custom_grants g JOIN mail_letters l ON l.id=g.letter WHERE l.player=? AND g.state!='acknowledged' ORDER BY l.sent,g.rowid").all(m.player)};
    if(!['prepare','ack'].includes(d.action)||typeof d.id!=='string'||typeof d.client!=='string'||!/^[a-f0-9]{64}$/.test(d.client))fail('bad_inbox_request');
    return this.hub.store.tx(()=>{const gift=this.hub.store.db.prepare('SELECT g.* FROM mail_custom_grants g JOIN mail_letters l ON l.id=g.letter WHERE g.id=? AND l.player=?').get(d.id,m.player);if(!gift)fail('gift_not_found');if(gift.client&&gift.client!==d.client)fail('gift_reserved');if(gift.state==='acknowledged')return {ok:true,id:gift.id,acknowledged:true};
      if(d.action==='ack'){if(gift.state!=='reserved')fail('gift_not_prepared');this.hub.store.db.prepare("UPDATE mail_custom_grants SET state='acknowledged' WHERE id=?").run(gift.id);return {ok:true,id:gift.id,acknowledged:true};}
      this.hub.store.db.prepare("UPDATE mail_custom_grants SET state='reserved',client=? WHERE id=?").run(d.client,gift.id);return {id:gift.id,data:gift.data};
    });
  }
}
