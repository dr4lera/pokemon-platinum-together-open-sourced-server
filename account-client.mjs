import {readFileSync,writeFileSync,renameSync,existsSync,mkdirSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {sign} from 'node:crypto';
import {newClient,privateKey,publicKey,b64,readToken,fail} from './identity.mjs';
import {accountBytes,validUsername} from './accounts.mjs';

export async function accountClient(action,{url,profile,name,out}={}){
  if(!['register','login','rename'].includes(action))fail('bad_account_action');
  let current=action==='register'?newClient():JSON.parse(readFileSync(resolve(profile),'utf8'));
  const target=new URL(action==='register'?url:current.hub);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash||!['','/'].includes(target.pathname))fail('bad_server_url');
  const post=async(path,m)=>{const r=await fetch(new URL(path,target),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m),signal:AbortSignal.timeout(10000)});const body=await r.json();if(!r.ok)fail(body.error??'account_request_failed');return body;};
  const info=await fetch(new URL('/private/server-info',target),{signal:AbortSignal.timeout(10000)}).then(r=>r.json());b64(info.hub_key,32,32);
  if(action!=='register'&&info.hub_key!==current.hub_key)fail('server_identity_changed');
  if(action!=='login'&&!validUsername(name))fail('invalid_username');
  const path=resolve(action==='register'?out:profile),pending=path+'.pending';mkdirSync(dirname(path),{recursive:true});
  if(action==='register'){
    if(existsSync(path))fail('profile_exists');
    if(existsSync(pending)){current=JSON.parse(readFileSync(pending,'utf8'));if(current.hub!==target.origin||current.hub_key!==info.hub_key)fail('server_identity_changed');}
    else writeFileSync(pending,JSON.stringify({...current,hub:target.origin,hub_key:info.hub_key}),{flag:'wx',mode:0o600});
  }
  let request={action,key:current.key,...(action==='login'?{}:{username:name})},challenge;
  try{challenge=await post('/auth/account/challenge',request);}catch(e){if(action!=='register'||e.code!=='already_enrolled')throw e;request={action:'login',key:current.key};challenge=await post('/auth/account/challenge',request);}
  const response=await post('/auth/account',{...request,nonce:challenge.nonce,sig:sign(null,accountBytes(request.action,b64(challenge.nonce,32,32),current.key,request.username??''),privateKey(b64(current.seed,32,32))).toString('base64')});
  const token=readToken({public:publicKey(b64(info.hub_key,32,32))},response.token);
  if(token.key.toString('base64')!==current.key||token.player!==response.player_id)fail('bad_account_response');
  const next={...current,...response,schema:1,hub:target.origin,hub_key:info.hub_key};
  if(action==='register'){if(existsSync(path))fail('profile_exists');writeFileSync(path,JSON.stringify(next,null,2),{flag:'wx',mode:0o600});}
  else{writeFileSync(path+'.tmp',JSON.stringify(next,null,2),{mode:0o600});renameSync(path+'.tmp',path);}
  if(action==='register'&&existsSync(pending))unlinkSync(pending);
  return {player:next.player_id,username:next.username};
}
