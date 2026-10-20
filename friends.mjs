import {fail} from './identity.mjs';
import {text} from './store.mjs';

export class Friends {
  constructor(hub){this.hub=hub;this.db=hub.store.db;}
  peers(id){return this.db.prepare('SELECT CASE WHEN a=? THEN b ELSE a END AS id FROM friendships WHERE a=? OR b=?').all(id,id,id).map(x=>String(x.id));}
  lookup(username){text(username,16);const rows=this.db.prepare('SELECT * FROM players WHERE lower(name)=lower(?) AND disabled=0').all(username);if(rows.length!==1)fail('username_unknown');return rows[0];}
  snapshot(id){
    const me=this.hub.store.playerInfo(id),username=player=>this.hub.store.playerInfo(String(player)).name;
    return {t:'social',me:{username:me.name,gp:0,badges:0,chat_lang:'en'},friends:this.peers(id).map(player=>{const online=this.hub.social.online(player);return {username:username(player),name:this.hub.store.trainer(player)?.name??username(player),online:online.length>0,where:online.some(c=>c.city)?'city':this.hub.connections.values().some(c=>c.authenticated&&c.kind==='realm'&&c.player===player)?'world':''};}),requests_in:this.db.prepare('SELECT sender FROM friend_requests WHERE recipient=? ORDER BY at_ms LIMIT 50').all(id).map(r=>username(r.sender)),requests_out:this.db.prepare('SELECT recipient FROM friend_requests WHERE sender=? ORDER BY at_ms LIMIT 50').all(id).map(r=>username(r.recipient)),guild:null,guild_invites:[],receipts:[],server_ms:Date.now()};
  }
  update(id){this.hub.social.send(id,this.snapshot(id));}
  presence(id){for(const peer of this.peers(id))this.update(peer);}
  pair(a,b){return BigInt(a)<BigInt(b)?[a,b]:[b,a];}
  handle(c,m){
    if(m.t==='social.get'){this.update(c.player);return true;}
    if(!['friend.add','friend.answer','friend.remove'].includes(m.t))return false;
    const target=String(this.lookup(m.username).id);if(target===c.player)fail('cannot_friend_self');const pair=this.pair(c.player,target);
    this.hub.store.tx(()=>{
      const exists=this.db.prepare('SELECT 1 FROM friendships WHERE a=? AND b=?').get(...pair);
      if(m.t==='friend.add'){
        if(exists)return;if(this.peers(c.player).length>=100||this.peers(target).length>=100)fail('friends_full');
        if(this.db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE sender=?').get(c.player).n>=50||this.db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE recipient=?').get(target).n>=50)fail('requests_full');
        const pending=this.db.prepare('SELECT 1 FROM friend_requests WHERE sender=? AND recipient=?').get(c.player,target);if(pending)return;
        this.db.prepare('INSERT INTO friend_requests VALUES(?,?,?)').run(c.player,target,Date.now());
      }else if(m.t==='friend.answer'){
        if(typeof m.accept!=='boolean')fail('bad_answer');if(!this.db.prepare('SELECT 1 FROM friend_requests WHERE sender=? AND recipient=?').get(target,c.player))fail('request_not_found');
        if(m.accept){if(this.peers(c.player).length>=100||this.peers(target).length>=100)fail('friends_full');this.db.prepare('INSERT OR IGNORE INTO friendships VALUES(?,?)').run(...pair);}
        this.db.prepare('DELETE FROM friend_requests WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)').run(c.player,target,target,c.player);
      }else{
        this.db.prepare('DELETE FROM friendships WHERE a=? AND b=?').run(...pair);
        this.db.prepare('DELETE FROM friend_requests WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?)').run(c.player,target,target,c.player);
      }
    });
    if(m.t==='friend.add')this.hub.social.send(target,{t:'friend.request',from:this.hub.store.playerInfo(c.player).name});
    this.update(c.player);this.update(target);return true;
  }
}
