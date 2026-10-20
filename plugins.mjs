import {Worker} from 'node:worker_threads';
import {mkdirSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from './identity.mjs';

const validId=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,47}$/.test(v);
export class Plugins {
 constructor(hub){this.hub=hub;this.directory=hub.pluginDirectory??join(hub.dir,'Plugins');this.loaded=new Map();this.closed=false;}
 list(){return [...this.loaded.values()].map(p=>({id:p.id,version:p.version,state:p.state,error:p.error??null}));}
 async start(){
  if(this.hub.pluginsEnabled===false){this.closed=false;return;}
  mkdirSync(this.directory,{recursive:true});this.closed=false;
  const folders=readdirSync(this.directory,{withFileTypes:true}).filter(d=>d.isDirectory()&&validId(d.name)).slice(0,16);
  await Promise.all(folders.map(d=>this.load(d.name)));
 }
 async load(id){
  const item={id,version:'unknown',state:'failed',pending:new Map(),sequence:Promise.resolve()};this.loaded.set(id,item);
  try{
   const folder=realpathSync(join(this.directory,id)),root=realpathSync(this.directory);
   if(!folder.startsWith(root+sep))throw new Error();
   const raw=readFileSync(join(folder,'plugin.json'));if(raw.length>8192)throw new Error();
   const manifest=JSON.parse(raw);
   if(manifest.id!==id||typeof manifest.version!=='string'||!/^\d+\.\d+\.\d+$/.test(manifest.version)||typeof manifest.enabled!=='boolean')throw new Error();
   item.version=manifest.version;
   if(!manifest.enabled){item.state='disabled';return;}
   if(typeof manifest.entry!=='string'||!/^[a-zA-Z0-9_-]+\.mjs$/.test(manifest.entry))throw new Error();
   const entry=realpathSync(join(folder,manifest.entry));if(!entry.startsWith(folder+sep))throw new Error();
   const dataDirectory=resolve(folder,'data');mkdirSync(dataDirectory,{recursive:true});
   item.worker=new Worker(new URL('./plugin-worker.mjs',import.meta.url),{workerData:{entry,dataDirectory},resourceLimits:{maxOldGenerationSizeMb:32,stackSizeMb:2},stdout:true,stderr:true});
   // Plugins run only local trusted code. Their console output is not forwarded
   // to clients or core logs, which could accidentally disclose private files.
   item.worker.stdout.resume();item.worker.stderr.resume();
   await new Promise((ready,reject)=>{
    const timer=setTimeout(()=>reject(new Error()),1500);
    item.worker.on('message',m=>{
     if(m.ready){clearTimeout(timer);item.state='running';ready();return;}
     const request=item.pending.get(m.id);if(!request)return;
     item.pending.delete(m.id);clearTimeout(request.timer);
     if(m.error){request.reject(new Error('plugin_failed'));this.disable(item,'plugin_failed');}
     else request.resolve(m.result);
    });
    item.worker.on('error',()=>{clearTimeout(timer);reject(new Error());this.disable(item,'plugin_failed');});
    item.worker.on('exit',()=>{clearTimeout(timer);reject(new Error());if(item.state==='running')this.disable(item,'plugin_exited');});
   });
  }catch{this.disable(item,'plugin_load_failed');}
 }
 disable(p,error){
  p.state='failed';p.error=error;
  for(const r of p.pending.values()){clearTimeout(r.timer);r.reject(new Error(error));}p.pending.clear();
  if(p.worker){const worker=p.worker;p.worker=null;worker.terminate().catch(()=>{});}
 }
 request(p,event){
  if(this.closed||p.state!=='running')return Promise.reject(new Error('plugin_unavailable'));
  if(p.queued>=16)return Promise.reject(new Error('plugin_busy'));
  p.queued=(p.queued??0)+1;
  const execute=()=>new Promise((resolve,reject)=>{
   if(this.closed||p.state!=='running'){reject(new Error('plugin_unavailable'));return;}
   const id=randomUUID(),timer=setTimeout(()=>{this.disable(p,'plugin_timeout');},1000);
   p.pending.set(id,{resolve,reject,timer});p.worker.postMessage({id,event});
  });
  const task=p.sequence.then(execute);p.sequence=task.catch(()=>{});
  return task.finally(()=>{p.queued--;});
 }
 emit(type,data){if(this.closed)return;for(const p of this.loaded.values())if(p.state==='running')this.request(p,{type,data}).catch(()=>{});}
 call(c,m){
  if(!validId(m.plugin)||typeof m.op!=='string'||!/^[0-9a-f-]{36}$/.test(m.op))fail('bad_plugin_call');
  if(Buffer.byteLength(JSON.stringify(m.args??null))>4096)fail('plugin_args_too_large');
  const p=this.loaded.get(m.plugin);if(!p||p.state!=='running')fail('plugin_unavailable');
  return this.request(p,{type:'call',op:m.op,data:{player:c.player,username:this.hub.store.player(c.player).name,args:m.args??null}});
 }
 async close(){this.closed=true;const stopping=[];for(const p of this.loaded.values()){if(p.worker){const worker=p.worker;p.worker=null;stopping.push(worker.terminate());}this.disable(p,'plugin_stopped');}await Promise.allSettled(stopping);}
 reload(){if(this.reloading)return this.reloading;this.reloading=(async()=>{await this.close();if(this.hub.closePromise)fail('server_stopping');this.loaded.clear();await this.start();if(this.hub.closePromise){await this.close();fail('server_stopping');}return this.list();})().finally(()=>{this.reloading=null;});return this.reloading;}
}
