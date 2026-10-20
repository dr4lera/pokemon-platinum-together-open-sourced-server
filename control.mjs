import {randomBytes,verify} from 'node:crypto';
import {b64,publicKey,sha,fail} from './identity.mjs';

export const controlBytes=(nonce,at,action='shutdown',value='')=>Buffer.concat([Buffer.from('PT-PRIVATE-CONTROL\0','ascii'),nonce,sha(Buffer.from(action+'\0'+at+(action==='advertise'?'\0'+value:''),'ascii'))]);
export class Control {
  constructor(hub){this.hub=hub;this.nonces=new Map();}
  local(req){if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))fail('local_control_only');}
  challenge(req){this.local(req);const now=Date.now();for(const[k,v]of this.nonces)if(v<now)this.nonces.delete(k);if(this.nonces.size>=32)fail('busy');const nonce=randomBytes(32).toString('base64');this.nonces.set(nonce,now+10000);return {nonce,server_ms:now};}
  shutdown(req,m){
    this.local(req);if(!['shutdown','advertise'].includes(m.action)||m.player!=='1')fail('not_server_owner');
    const expires=this.nonces.get(m.nonce);if(!expires||expires<Date.now())fail('stale_control');if(!Number.isSafeInteger(m.server_ms)||Math.abs(Date.now()-m.server_ms)>30000)fail('stale_control');
    const p=this.hub.store.player(m.player);if(!verify(null,controlBytes(b64(m.nonce,32,32),m.server_ms,m.action,m.url),publicKey(b64(p.key,32,32)),b64(m.sig,64,64)))fail('bad_proof');
    this.nonces.delete(m.nonce);
    if(m.action==='advertise'){let u;try{u=new URL(m.url);}catch{fail('bad_public_url');}if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash||m.url.length>240)fail('bad_public_url');this.hub.url=u.origin;return {ok:true,action:'advertise',url:this.hub.url};}
    return {ok:true,action:'shutdown'};
  }
}
