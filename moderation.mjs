import {isIP} from 'node:net';
import {fail} from './identity.mjs';
import {text} from './store.mjs';

export function canonicalIp(value){
 if(typeof value!=='string')fail('bad_ip');
 let ip=value.trim().toLowerCase();
 if(ip.startsWith('::ffff:')&&isIP(ip.slice(7))===4)ip=ip.slice(7);
 const family=isIP(ip);if(!family||ip.includes('%'))fail('bad_ip');
 return family===6?new URL('http://['+ip+']/').hostname.slice(1,-1):ip;
}
export class Moderation {
 constructor(hub){this.hub=hub;this.db=hub.store.db;}
 blockedIp(ip){return !!this.db.prepare("SELECT 1 FROM server_bans WHERE kind='ip' AND target=?").get(canonicalIp(ip));}
 address(req){const transport=canonicalIp(req.socket.remoteAddress);if(this.hub.trustedProxy&&['127.0.0.1','::1'].includes(transport)&&req.headers?.['cf-connecting-ip'])return canonicalIp(req.headers['cf-connecting-ip']);return transport;}
 list(){return this.db.prepare("SELECT b.*,p.name AS username FROM server_bans b LEFT JOIN players p ON b.kind='user' AND CAST(p.id AS TEXT)=b.target ORDER BY b.at_ms DESC").all();}
 players(){return this.db.prepare('SELECT id,name FROM players WHERE disabled=0 ORDER BY id LIMIT 1000').all().map(p=>({player:String(p.id),username:p.name,online:[...this.hub.connections].some(c=>c.authenticated&&c.player===String(p.id)),addresses:[...new Set([...this.hub.connections].filter(c=>c.authenticated&&c.player===String(p.id)).map(c=>c.ip))],banned:!!this.db.prepare("SELECT 1 FROM server_bans WHERE kind='user' AND target=?").get(String(p.id))}));}
 action(action,value){
  if(action==='list-bans')return {ok:true,bans:this.list()};
  if(action==='list-players')return {ok:true,players:this.players()};
  if(!['ban-user','unban-user','ban-ip','unban-ip'].includes(action))fail('bad_control_action');
  let data;try{data=JSON.parse(value);}catch{fail('bad_ban');}
  text(data.target,128);if(typeof data.reason!=='string'||data.reason.length>300||/[\x00-\x1f\x7f]/.test(data.reason))fail('bad_reason');
  const kind=action.endsWith('-ip')?'ip':'user';let target;
  if(kind==='ip')target=canonicalIp(data.target);
  else {const p=this.db.prepare('SELECT id FROM players WHERE lower(name)=lower(?)').get(data.target);if(!p)fail('username_unknown');target=String(p.id);if(target==='1'&&action==='ban-user')fail('cannot_ban_server_owner');}
  const ban=action.startsWith('ban-');
  if(ban)this.db.prepare('INSERT INTO server_bans(kind,target,reason,at_ms) VALUES(?,?,?,?) ON CONFLICT(kind,target) DO UPDATE SET reason=excluded.reason,at_ms=excluded.at_ms').run(kind,target,data.reason,Date.now());
  else this.db.prepare('DELETE FROM server_bans WHERE kind=? AND target=?').run(kind,target);
  let disconnected=0;
  if(ban)for(const c of this.hub.connections)if(kind==='user'?c.player===target:c.ip===target){c.ws.close(1008,'server ban');disconnected++;}
  this.hub.log('moderation',{action,kind,disconnected});
  return {ok:true,action,disconnected,bans:this.list()};
 }
}
