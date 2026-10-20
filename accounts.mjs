import {randomBytes,verify} from 'node:crypto';
import {b64,publicKey,sha,fail} from './identity.mjs';

export const validUsername=name=>typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_]{2,15}$/.test(name);
export const accountBytes=(action,nonce,key,username='')=>Buffer.concat([Buffer.from('PT-PRIVATE-ACCOUNT\0','ascii'),nonce,sha(Buffer.from(action+'\0'+username.toLowerCase()+'\0'+key,'ascii'))]);
export class Accounts {
  constructor(hub){this.hub=hub;this.challenges=new Map();this.rates=new Map();}
  validate(m){
    if(!['register','login','rename'].includes(m.action))fail('bad_account_action');b64(m.key,32,32);
    if(m.action!=='login'&&!validUsername(m.username))fail('invalid_username');
    if(m.action==='login'&&m.username!==undefined&&m.username!=='')fail('bad_account_action');
  }
  challenge(req,m){
    this.validate(m);const now=Date.now();for(const[k,v]of this.challenges)if(v.expires<now)this.challenges.delete(k);for(const[k,v]of this.rates)if(v.until<now)this.rates.delete(k);
    const ip=req.socket.remoteAddress,rate=this.rates.get(ip)??{until:now+60000,count:0};if(++rate.count>30||this.challenges.size>=1024)fail('account_rate_limit');this.rates.set(ip,rate);
    if(m.action==='register'){
      if(!this.hub.store.db.prepare('SELECT 1 FROM players LIMIT 1').get()&&(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers?.['cf-connecting-ip']||req.headers?.['x-forwarded-for']))fail('owner_not_initialized');
      if(this.hub.store.db.prepare('SELECT 1 FROM players WHERE key=?').get(m.key))fail('already_enrolled');
      if(this.hub.store.db.prepare('SELECT 1 FROM players WHERE lower(name)=lower(?)').get(m.username))fail('username_taken');
    }else if(!this.hub.store.db.prepare('SELECT 1 FROM players WHERE key=? AND disabled=0').get(m.key))fail('account_not_found');
    const nonce=randomBytes(32).toString('base64');this.challenges.set(nonce,{action:m.action,key:m.key,username:m.username??'',ip,expires:now+15000});return {nonce,expires_at_ms:now+15000};
  }
  finish(req,m){
    this.validate(m);const c=this.challenges.get(m.nonce);
    if(!c||c.expires<Date.now()||c.ip!==req.socket.remoteAddress||c.action!==m.action||c.key!==m.key||c.username!==(m.username??''))fail('stale_account_challenge');
    if(!verify(null,accountBytes(m.action,b64(m.nonce,32,32),m.key,m.username??''),publicKey(b64(m.key,32,32)),b64(m.sig,64,64)))fail('bad_proof');
    this.challenges.delete(m.nonce);
    let player;
    if(m.action==='register'){
      player=this.hub.store.enroll(m.username,m.key);
      this.hub.store.putTrainer(String(player.id),{name:player.name.slice(0,10),look:0,outfit:0,tutorial_done:false,revision:0});
    }
    else{
      player=this.hub.store.db.prepare('SELECT * FROM players WHERE key=? AND disabled=0').get(m.key);if(!player)fail('account_not_found');
      if(m.action==='rename'){
        this.hub.store.rename(String(player.id),m.username);player=this.hub.store.player(String(player.id));
        this.hub.friends.presence(String(player.id));
      }
    }
    return {...this.hub.credentials(String(player.id)),username:player.name,hub_key:this.hub.identity.pin};
  }
}
