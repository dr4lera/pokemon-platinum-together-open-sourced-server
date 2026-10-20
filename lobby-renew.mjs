import {verify} from 'node:crypto';
import {sha,b64,publicKey,issueToken,readToken,fail} from './identity.mjs';

// Independently verified against the native serializer using synthetic inputs.
export function lobbyRenewProof(bytes,op){
 if(typeof op!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(op))fail('bad_op');
 return Buffer.concat([Buffer.from('PT2-RENEW\0','ascii'),Buffer.from(op.replaceAll('-',''),'hex'),sha(bytes)]);
}
export function renewLobby(hub,c,m){
 const bytes=lobbyRenewProof(c.account.bytes,m.op),signature=b64(m.sig,64,64),now=Date.now();
 const prior=c.lastRenew;
 if(prior?.op===m.op&&prior.until>now){if(prior.sig!==m.sig)fail('op_conflict');return prior.response;}
 const p=hub.store.player(c.player);
 if(p.key!==c.account.key.toString('base64')||!verify(null,bytes,publicKey(b64(p.key,32,32)),signature))fail('bad_proof');
 if(prior&&prior.at>now-30000)fail('renew_rate_limit');
 const issued=issueToken(hub.identity,c.player,p.key),account=readToken(hub.identity,issued.token);
 const response={t:'auth.renewed',token:issued.token,expires_at_ms:account.expires,server_ms:now};
 c.account=account;c.expires=account.expires;c.lastRenew={op:m.op,sig:m.sig,response,at:now,until:now+120000};
 return response;
}
