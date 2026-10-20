import {verify} from 'node:crypto';
import {sha,b64,publicKey,fail} from './identity.mjs';

// Own compatible implementation of the shipped launcher's 60-byte proof.
export function refreshProof(token){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))fail('bad_refresh');
  const domain=Buffer.from('PT2-REFRESH\0','ascii'),id=sha(Buffer.concat([domain,Buffer.from(token,'ascii')])).subarray(0,16);
  id[6]=(id[6]&15)|64;id[8]=(id[8]&63)|128;
  const hex=id.toString('hex'),op=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return {op,bytes:Buffer.concat([domain,id,sha(Buffer.from(token,'ascii'))])};
}
export function renew(hub,m){
  const expected=refreshProof(m.refresh_token);if(m.op!==expected.op)fail('bad_op');
  const db=hub.store.db,hash=sha(m.refresh_token).toString('hex'),now=Date.now();
  db.prepare('DELETE FROM refresh_replays WHERE expires<?').run(now);
  return hub.store.tx(()=>{
    const replay=db.prepare('SELECT * FROM refresh_replays WHERE hash=?').get(hash);
    const r=db.prepare('SELECT * FROM refresh WHERE hash=?').get(hash);
    if(!replay&&(!r||r.expires<now))fail('bad_refresh');
    const p=hub.store.player(String((replay??r).player));
    if(!verify(null,expected.bytes,publicKey(b64(p.key,32,32)),b64(m.sig,64,64)))fail('bad_proof');
    if(replay)return JSON.parse(replay.response);
    db.prepare('DELETE FROM refresh WHERE hash=?').run(hash);
    const response=hub.credentials(String(r.player));response.username=p.name;
    db.prepare('INSERT INTO refresh_replays(hash,player,response,expires) VALUES(?,?,?,?)').run(hash,r.player,JSON.stringify(response),now+120000);
    return response;
  });
}
