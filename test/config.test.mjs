import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseConfig,loadConfig,createConfig,exampleConfig} from '../config.mjs';
import {Hub} from '../hub.mjs';

test('server config resolves paths against its own folder and refuses accidental settings',()=>{
 const base=resolve(tmpdir(),'pt-config-base'),raw=structuredClone(exampleConfig);
 raw.name='My Inverna';raw.network.bind='0.0.0.0';raw.network.publicUrl='https://example.test/';raw.plugins.enabled=false;
 const config=parseConfig(raw,base);
 assert.equal(config.dir,resolve(base,'../Data'));assert.equal(config.pluginDirectory,resolve(base,'../Data/Plugins'));
 assert.equal(config.publicUrl,'https://example.test');assert.equal(config.pluginsEnabled,false);assert.equal(config.friendCodesEnabled,false);
 raw.invitations.friendCodes=true;assert.equal(parseConfig(raw,base).friendCodesEnabled,true);
 const invalidInvites=structuredClone(raw);invalidInvites.invitations.friendCodes='true';assert.throws(()=>parseConfig(invalidInvites,base),/Server config:/);
 for(const change of [r=>r.network.port=0,r=>r.network.port='8788',r=>r.network.bind='example.com',r=>r.network.publicUrl='https://user:password@example.test',r=>r.network.publicUrl='https://example.test/path',r=>r.network.trustedLoopbackProxy='false',r=>r.plugins.enabled=1,r=>r.network.potr=42,r=>r.story={unimplemented:true}]){
  const invalid=structuredClone(raw);change(invalid);assert.throws(()=>parseConfig(invalid,base),/Server config:/);
 }
});
test('config creation never replaces host settings and malformed JSON fails before startup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-config-'));try{
  const file=join(dir,'server.json');createConfig(file);assert.ok(loadConfig(file));assert.throws(()=>createConfig(file),{code:'EEXIST'});
  const original=readFileSync(file,'utf8');assert.equal(JSON.parse(original).schema,1);
  writeFileSync(file,'{');assert.throws(()=>loadConfig(file),/invalid JSON/);
  assert.equal(loadConfig(join(dir,'missing.json'),{optional:true}),null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('backend applies config identity and never executes plugins when globally disabled',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pt-config-live-'));let hub;
 try{
  const folder=join(dir,'plugins','probe');mkdirSync(folder,{recursive:true});
  writeFileSync(join(folder,'plugin.json'),JSON.stringify({id:'probe',version:'1.0.0',enabled:true,entry:'main.mjs'}));
  const marker=join(dir,'executed');writeFileSync(join(folder,'main.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');`);
  hub=new Hub({dir:join(dir,'data'),port:0,name:'Custom Inverna',log:false,pluginsEnabled:false,pluginDirectory:join(dir,'plugins')});await hub.start();
  const info=await fetch(hub.url+'/private/server-info').then(r=>r.json());assert.equal(info.name,'Custom Inverna');
  assert.deepEqual(hub.plugins.list(),[]);await hub.plugins.reload();assert.equal(existsSync(marker),false);
 }finally{if(hub)await hub.close();rmSync(dir,{recursive:true,force:true});}
});
