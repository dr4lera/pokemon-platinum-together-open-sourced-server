import {readFileSync,writeFileSync} from 'node:fs';
import {sign} from 'node:crypto';
import {b64,privateKey,fail} from './identity.mjs';
import {controlBytes} from './control.mjs';

export async function adminClient({profile,action,target='',reason='',out}){
 const p=JSON.parse(readFileSync(profile,'utf8')),url=new URL(p.hub);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')fail('local_control_only');
 const request=async(path,options)=>{const r=await fetch(new URL(path,url),{...options,signal:AbortSignal.timeout(8000)});const d=await r.json();if(!r.ok)fail(d.error??'control_refused');return d;};
 const info=await request('/private/server-info');if(info.hub_key!==p.hub_key)fail('server_identity_changed');
 const challenge=await request('/private/control/challenge');
 const value=JSON.stringify({target,reason});
 const m={action,value,player:p.player_id,...challenge,sig:sign(null,controlBytes(b64(challenge.nonce,32,32),challenge.server_ms,action,value),privateKey(b64(p.seed,32,32))).toString('base64')};
 const result=await request('/private/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)});
 if(out)writeFileSync(out,JSON.stringify(result),{flag:'wx',mode:0o600});return result;
}
