import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync, mkdirSync,readFileSync,renameSync} from 'node:fs';
import {Hub} from './hub.mjs';
import {newClient} from './identity.mjs';
import {privateKey,b64} from './identity.mjs';
import {sign} from 'node:crypto';
import {controlBytes} from './control.mjs';
import {accountClient} from './account-client.mjs';
import {inboxClient} from './inbox-client.mjs';
import {adminClient} from './admin-client.mjs';
import {loadConfig,createConfig} from './config.mjs';
import {worldsClient} from './worlds-client.mjs';

const args=process.argv.slice(2);const value=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const dir=resolve(value('data',fileURLToPath(new URL('../Data/',import.meta.url))));
if(args[0]==='init-config'){
  console.log('Created '+createConfig(value('config',fileURLToPath(new URL('./server.json',import.meta.url)))));
}else if(args[0]==='check-config'){
  loadConfig(value('config',fileURLToPath(new URL('./server.json',import.meta.url))));console.log('Server configuration is valid');
}else if(['worlds','discord-invite','party-join'].includes(args[0])){
  try{await worldsClient({profile:value('profile'),out:value('out'),action:args[0],code:value('code')});console.log('Lobby request complete');}catch(e){console.error(JSON.stringify({error:e.code??e.message??'world_list_failed'}));process.exitCode=1;}
}else if(args[0]==='moderate'){
  try{await adminClient({profile:value('profile'),action:value('action'),target:value('target',''),reason:value('reason',''),out:value('out')});console.log('Server management request complete');}catch(e){console.error(JSON.stringify({error:e.code??'control_failed'}));process.exitCode=1;}
}else if(args[0]==='inbox'){
  try{await inboxClient({profile:value('profile'),action:value('action'),id:value('id'),client:value('client'),out:value('out')});console.log('Gift inbox request complete');}catch(e){console.error(JSON.stringify({error:e.code??'inbox_failed'}));process.exitCode=1;}
}else if(args[0]?.startsWith('account-')){
  try{await accountClient(args[0].slice(8),{url:value('url'),profile:value('profile'),name:value('name'),out:value('out')});console.log('Private account ready');}
  catch(e){console.error(JSON.stringify({error:e.code??'account_request_failed'}));process.exitCode=1;}
}else if(['stop-local','advertise-local'].includes(args[0])){
  const p=JSON.parse(readFileSync(resolve(value('profile','')),'utf8')),url=new URL(p.hub);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Local control only');
  const info=await fetch(new URL('/private/server-info',url)).then(r=>r.json());if(info.hub_key!==p.hub_key)throw new Error('Server identity mismatch');
  const challenge=await fetch(new URL('/private/control/challenge',url)).then(r=>r.json());
  const action=args[0]==='stop-local'?'shutdown':'advertise',publicUrl=value('url','');
  const request={action,player:p.player_id,...challenge,...(action==='advertise'?{url:publicUrl}:{}),sig:sign(null,controlBytes(b64(challenge.nonce,32,32),challenge.server_ms,action,publicUrl),privateKey(b64(p.seed,32,32))).toString('base64')};
  const r=await fetch(new URL('/private/control',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});if(!r.ok)throw new Error('Server refused local control');console.log(action==='shutdown'?'Private server closed cleanly':'Public relay address updated');
}else{
const serving=!['refresh-local','enroll'].includes(args[0]);
const config=serving?loadConfig(value('config',fileURLToPath(new URL('./server.json',import.meta.url))),{optional:!args.includes('--config')}):null;
const hub=new Hub({...config,dir:value('data',config?.dir??dir),port:Number(value('port',config?.port??8787)),host:value('bind',config?.host??'127.0.0.1'),publicUrl:value('url',config?.publicUrl)});
if(args[0]==='refresh-local'){
  // Local owner utility: the profile must match this server's existing identity.
  const destination=resolve(value('profile','')),p=JSON.parse(readFileSync(destination,'utf8'));
  const player=hub.store.player(p.player_id);
  if(p.hub_key!==hub.identity.pin||player.key!==p.key)throw new Error('Profile belongs to another server');
  const next={...p,...hub.credentials(p.player_id)};
  writeFileSync(destination+'.tmp',JSON.stringify(next,null,2),{mode:0o600});renameSync(destination+'.tmp',destination);hub.store.close();
  console.log('Private profile renewed locally');
}else if(args[0]==='enroll'){
  const name=value('name','PrivateTrainer'),client=newClient(),credentials=hub.enroll(name,client.key);
  const destination=resolve(value('out',join(dir,`client-${credentials.player_id}.json`)));mkdirSync(resolve(destination,'..'),{recursive:true});
  writeFileSync(destination,JSON.stringify({schema:1,hub:value('url','http://127.0.0.1:8787'),hub_key:hub.identity.pin,...client,...credentials},null,2),{flag:'wx',mode:0o600});
  console.log(`Private player ${credentials.player_id} provisioned: ${destination}`);hub.store.close();
}else{
  await hub.start();console.log(`Private backend: ${hub.url}\nPublic signing key: ${hub.identity.pin}\nStatus: development; dedicated game simulation and end-to-end native play remain unverified.`);
  let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await hub.close();process.exitCode=0;});
}
}
