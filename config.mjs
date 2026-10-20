import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {isIP} from 'node:net';

export const exampleConfig={
 schema:1,name:'Platinum Private Worlds',role:'combined',data:'../Data',
 network:{bind:'127.0.0.1',port:8788,publicUrl:null,trustedLoopbackProxy:false},
 logging:{enabled:true},plugins:{enabled:true,directory:'../Data/Plugins'},invitations:{friendCodes:false}
};
const bad=message=>{throw new Error('Server config: '+message);};
function object(value,keys,label){
 if(!value||typeof value!=='object'||Array.isArray(value))bad(label+' must be an object');
 for(const key of Object.keys(value))if(!keys.includes(key))bad('unknown setting '+label+'.'+key);
 return value;
}
const boolean=(v,label)=>{if(typeof v!=='boolean')bad(label+' must be true or false');return v;};
const path=(v,base,label)=>{if(typeof v!=='string'||!v.trim()||v.includes('\0'))bad(label+' must be a path');return resolve(base,v);};
export function parseConfig(raw,base){
 object(raw,Object.keys(exampleConfig),'server');
 if(raw.schema!==1)bad('schema must be 1');
 const role=raw.role??'combined';if(!['combined','inverna','world'].includes(role))bad('role must be combined, inverna or world');
 const name=raw.name??exampleConfig.name;
 if(typeof name!=='string'||!name.trim()||name.length>80||/[\x00-\x1f\x7f]/.test(name))bad('name must contain 1-80 printable characters');
 const n={...exampleConfig.network,...object(raw.network??{},Object.keys(exampleConfig.network),'network')};
 if(typeof n.bind!=='string'||!isIP(n.bind))bad('network.bind must be a numeric IPv4 or IPv6 address');
 if(!Number.isInteger(n.port)||n.port<1||n.port>65535)bad('network.port must be 1-65535');
 let publicUrl;
 if(n.publicUrl!==null){
  let u;try{u=new URL(n.publicUrl);}catch{bad('network.publicUrl must be an HTTP(S) origin or null');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')bad('network.publicUrl must be an HTTP(S) origin');
  publicUrl=u.origin;
 }
 const logging={...exampleConfig.logging,...object(raw.logging??{},['enabled'],'logging')};
 const plugins={...exampleConfig.plugins,...object(raw.plugins??{},['enabled','directory'],'plugins')};
 const invitations={...exampleConfig.invitations,...object(raw.invitations??{},['friendCodes'],'invitations')};
 return {name:name.trim(),role,dir:path(raw.data??exampleConfig.data,base,'data'),host:n.bind,port:n.port,publicUrl,
  trustedLoopbackProxy:boolean(n.trustedLoopbackProxy,'network.trustedLoopbackProxy'),
  log:boolean(logging.enabled,'logging.enabled'),pluginsEnabled:boolean(plugins.enabled,'plugins.enabled'),
  pluginDirectory:path(plugins.directory,base,'plugins.directory'),friendCodesEnabled:boolean(invitations.friendCodes,'invitations.friendCodes')};
}
export function loadConfig(file,{optional=false}={}){
 const target=resolve(file);if(optional&&!existsSync(target))return null;
 const bytes=readFileSync(target);if(bytes.length>65536)bad('file exceeds 64 KiB');
 let raw;try{raw=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{bad('invalid JSON in '+target);}
 return parseConfig(raw,dirname(target));
}
export function createConfig(file){
 const target=resolve(file);writeFileSync(target,JSON.stringify(exampleConfig,null,2)+'\n',{flag:'wx'});return target;
}
