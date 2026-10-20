import {DatabaseSync} from 'node:sqlite';
import {fail, b64, sha} from './identity.mjs';

export function text(value, max=24) {if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||/[\x00-\x1f\x7f]/.test(value)) fail('bad_text');return value;}
export function integer(value,min=0,max=0x7fffffff) {if(!Number.isSafeInteger(value)||value<min||value>max) fail('bad_number');return value;}
export function pairs(value) {
  if(!Array.isArray(value)||value.length>2048) fail('bad_story');
  const seen=new Set();
  for(const p of value) {if(!Array.isArray(p)||p.length!==2) fail('bad_story');integer(p[0],0,65535);integer(p[1],0,65535);if(seen.has(p[0]))fail('bad_story');seen.add(p[0]);}
  return value;
}
export class Store {
  constructor(path) {
    this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS players(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,key TEXT NOT NULL UNIQUE,disabled INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS unique_private_username ON players(lower(name));
      CREATE TABLE IF NOT EXISTS server_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS server_bans(kind TEXT NOT NULL CHECK(kind IN ('user','ip')),target TEXT NOT NULL,reason TEXT NOT NULL,at_ms INTEGER NOT NULL,PRIMARY KEY(kind,target));
      CREATE TABLE IF NOT EXISTS refresh(hash TEXT PRIMARY KEY,player INTEGER NOT NULL REFERENCES players(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh_replays(hash TEXT PRIMARY KEY,player INTEGER NOT NULL REFERENCES players(id),response TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,player INTEGER NOT NULL REFERENCES players(id),body TEXT NOT NULL,op TEXT NOT NULL,at_ms INTEGER NOT NULL,UNIQUE(player,op));
      CREATE INDEX IF NOT EXISTS chat_channel_id ON chat_messages(channel,id);
      CREATE TABLE IF NOT EXISTS chat_reads(player INTEGER NOT NULL REFERENCES players(id),channel TEXT NOT NULL,upto INTEGER NOT NULL,PRIMARY KEY(player,channel));
      CREATE TABLE IF NOT EXISTS trainers(player INTEGER PRIMARY KEY REFERENCES players(id),name TEXT NOT NULL,look INTEGER NOT NULL,outfit INTEGER NOT NULL,tutorial_done INTEGER NOT NULL,revision INTEGER NOT NULL,created_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS friendships(a INTEGER NOT NULL REFERENCES players(id),b INTEGER NOT NULL REFERENCES players(id),PRIMARY KEY(a,b),CHECK(a<b));
      CREATE TABLE IF NOT EXISTS friend_requests(sender INTEGER NOT NULL REFERENCES players(id),recipient INTEGER NOT NULL REFERENCES players(id),at_ms INTEGER NOT NULL,PRIMARY KEY(sender,recipient),CHECK(sender!=recipient));
      CREATE TABLE IF NOT EXISTS realms(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,owner INTEGER NOT NULL REFERENCES players(id),created INTEGER NOT NULL,setup TEXT,rival TEXT,story TEXT NOT NULL DEFAULT '[]',story_rev INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS members(realm INTEGER NOT NULL REFERENCES realms(id),player INTEGER NOT NULL REFERENCES players(id),seat INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,bytes TEXT,PRIMARY KEY(realm,player),UNIQUE(realm,seat));
      CREATE TABLE IF NOT EXISTS world_visits(player INTEGER NOT NULL REFERENCES players(id),kind TEXT NOT NULL,world TEXT NOT NULL,owner INTEGER NOT NULL REFERENCES players(id),name TEXT NOT NULL,joined_at_ms INTEGER NOT NULL,PRIMARY KEY(player,kind,world));
      CREATE TABLE IF NOT EXISTS saves(realm INTEGER NOT NULL REFERENCES realms(id),counter INTEGER NOT NULL,hash TEXT NOT NULL,at_ms INTEGER NOT NULL,op TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(realm,counter),UNIQUE(realm,op));
      PRAGMA user_version=1;`);
    const chatColumns=new Set(this.db.prepare('PRAGMA table_info(chat_messages)').all().map(c=>c.name));
    for(const [name,type]of [['plugin','TEXT'],['recipient','INTEGER'],['reply_to','TEXT']])if(!chatColumns.has(name))this.db.exec(`ALTER TABLE chat_messages ADD COLUMN ${name} ${type}`);

  }
  tx(fn) {this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  close(){this.db.close();}
  visit(player,kind,world,owner,name){this.db.prepare('INSERT INTO world_visits(player,kind,world,owner,name,joined_at_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(player,kind,world) DO UPDATE SET name=excluded.name,joined_at_ms=excluded.joined_at_ms').run(player,kind,world,owner,name,Date.now());}
  joinedWorlds(player){return this.db.prepare("SELECT v.kind,v.world,v.name,CAST(v.owner AS TEXT) AS owner,v.joined_at_ms,p.name AS owner_name FROM world_visits v JOIN players p ON p.id=v.owner WHERE v.player=? AND (v.kind='relay' OR EXISTS(SELECT 1 FROM members m WHERE CAST(m.realm AS TEXT)=v.world AND m.player=v.player)) ORDER BY v.joined_at_ms DESC LIMIT 100").all(player);}
  playerInfo(id){const p=this.db.prepare('SELECT * FROM players WHERE id=? AND disabled=0').get(id);if(!p)fail('bad_player');return p;}
  player(id){const p=this.playerInfo(id);if(this.db.prepare("SELECT 1 FROM server_bans WHERE kind='user' AND target=?").get(String(p.id)))fail('user_banned');return p;}
  rename(id,name){if(typeof name!=='string'||!/^[A-Za-z][A-Za-z0-9_]{2,15}$/.test(name))fail('invalid_username');return this.tx(()=>{this.player(id);if(this.db.prepare('SELECT 1 FROM players WHERE lower(name)=lower(?) AND id!=?').get(name,id))fail('username_taken');this.db.prepare('UPDATE players SET name=? WHERE id=?').run(name,id);this.db.prepare('UPDATE trainers SET name=?,revision=revision+1 WHERE player=?').run(name.slice(0,10),id);return this.player(id);});}
  trainer(player){const p=this.db.prepare('SELECT name,look,outfit,tutorial_done,revision,created_at_ms FROM trainers WHERE player=?').get(player);return p?{...p,tutorial_done:!!p.tutorial_done}:null;}
  putTrainer(player,m){text(m.name,10);if(!/^[A-Za-z0-9 _-]+$/.test(m.name))fail('name_refused');integer(m.look,0,255);integer(m.outfit,0,65535);integer(m.revision,0);if(typeof m.tutorial_done!=='boolean')fail('bad_trainer');return this.tx(()=>{const old=this.trainer(player);if(m.revision!==(old?.revision??0))return {t:'trainer',trainer:old,applied:false};this.db.prepare('INSERT INTO trainers(player,name,look,outfit,tutorial_done,revision,created_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT(player) DO UPDATE SET name=excluded.name,look=excluded.look,outfit=excluded.outfit,tutorial_done=excluded.tutorial_done,revision=excluded.revision').run(player,m.name,m.look,m.outfit,m.tutorial_done?1:0,m.revision+1,old?.created_at_ms??Date.now());return {t:'trainer',trainer:this.trainer(player),applied:true};});}
  enroll(name,key){text(name,16);if(!/^[A-Za-z][A-Za-z0-9_]{2,15}$/.test(name))fail('invalid_username');b64(key,32,32);return this.tx(()=>{if(this.db.prepare('SELECT 1 FROM players WHERE key=?').get(key))fail('already_enrolled');if(this.db.prepare('SELECT 1 FROM players WHERE lower(name)=lower(?)').get(name))fail('username_taken');const r=this.db.prepare('INSERT INTO players(name,key) VALUES(?,?)').run(name,key);return this.player(String(r.lastInsertRowid));});}
  create(owner,name){this.player(owner);text(name);return this.tx(()=>{if(this.db.prepare('SELECT COUNT(*) AS n FROM realms WHERE owner=?').get(owner).n>=16)fail('realm_limit');const r=this.db.prepare('INSERT INTO realms(name,owner,created) VALUES(?,?,?)').run(name,owner,Date.now());const id=String(r.lastInsertRowid);this.db.prepare('INSERT INTO members(realm,player,seat) VALUES(?,?,0)').run(id,owner);return this.realm(id,owner);});}
  realm(id,player){if(typeof id!=='string'||!/^[1-9][0-9]{0,18}$/.test(id))fail('bad_realm');const r=this.db.prepare('SELECT r.*,m.seat,m.revision,m.bytes FROM realms r JOIN members m ON m.realm=r.id WHERE r.id=? AND m.player=?').get(id,player);if(!r)fail('not_a_member');return r;}
  members(id){return this.db.prepare('SELECT player,seat FROM members WHERE realm=? ORDER BY seat').all(id).map(m=>({player:String(m.player),seat:m.seat}));}
  list(player){return this.db.prepare('SELECT r.id FROM realms r JOIN members m ON m.realm=r.id WHERE m.player=? ORDER BY r.id LIMIT 64').all(player).map(x=>this.realm(String(x.id),player));}
  invite(id,owner,target){this.realm(id,owner);const r=this.realm(id,owner);if(String(r.owner)!==owner)fail('not_owner');this.player(target);return this.tx(()=>{const m=this.members(id);if(m.some(x=>x.player===target))return;const seat=[0,1,2,3].find(n=>!m.some(x=>x.seat===n));if(seat===undefined)fail('realm_full');this.db.prepare('INSERT INTO members(realm,player,seat) VALUES(?,?,?)').run(id,target,seat);});}
  publish(id,player,setup,story,rival){const r=this.realm(id,player);if(String(r.owner)!==player)fail('not_owner');b64(setup,1024);if(!Buffer.from(setup,'base64').length)fail('bad_setup');if(rival!==null)b64(rival,48);pairs(story);return this.tx(()=>{if(r.setup!==null)fail('world_published');this.db.prepare('UPDATE realms SET setup=?,story=?,rival=?,story_rev=story_rev+1 WHERE id=?').run(setup,JSON.stringify(story),rival,id);return this.realm(id,player);});}
  latest(id){return this.db.prepare('SELECT counter,hash,at_ms,length(payload) AS size FROM saves WHERE realm=? ORDER BY counter DESC LIMIT 1').get(id)??null;}
  save(id,player,op,counter,hash,payload){this.realm(id,player);integer(counter,0,0xffffffff);if(!Buffer.isBuffer(payload)||!payload.length||payload.length>1048576||sha(payload).toString('hex')!==hash)fail('bad_save_hash');return this.tx(()=>{const old=this.db.prepare('SELECT counter,hash FROM saves WHERE realm=? AND op=?').get(id,op);if(old){if(old.counter!==counter||old.hash!==hash)fail('op_conflict');return old;}const last=this.latest(id);if(counter!==(last?last.counter+1:1))fail('save_conflict');this.db.prepare('INSERT INTO saves(realm,counter,hash,at_ms,op,payload) VALUES(?,?,?,?,?,?)').run(id,counter,hash,Date.now(),op,payload);return this.latest(id);});}
  payload(id){const r=this.db.prepare('SELECT * FROM saves WHERE realm=? ORDER BY counter DESC LIMIT 1').get(id);return r?{...r,payload:Buffer.from(r.payload)}:null;}
}
