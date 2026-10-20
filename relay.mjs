import {randomUUID,randomBytes,verify} from 'node:crypto';
import {b64,sha,fail,publicKey} from './identity.mjs';
import {routeFrame} from './frames.mjs';
const limits={game_frames_per_second:120,game_bytes_per_second:262144,game_burst_bytes:262144};
export class Relay {
  constructor(hub){this.hub=hub;this.sessions=new Map();this.tickets=new Map();this.requests=new Map();hub.store.db.exec('CREATE TABLE IF NOT EXISTS relay_worlds(owner INTEGER PRIMARY KEY REFERENCES players(id),world TEXT NOT NULL UNIQUE)');}
  peers(s){return [...this.hub.connections].filter(c=>c.kind==='relay'&&c.authenticated&&c.session===s.id&&c.ws.readyState===1);}
  roster(s){return this.peers(s).map(c=>({seat:c.seat,player_id:c.player,role:c.seat===0?'host':'guest'}));}
  update(s){s.epoch++;for(const c of this.peers(s))this.hub.send(c,{t:'roster',seats:this.roster(s)});}
  sweep(){const now=Date.now();for(const[k,v]of this.tickets)if(v.expires<now)this.tickets.delete(k);for(const[k,s]of this.sessions)if(!this.peers(s).length&&s.activity<now-600000)this.sessions.delete(k);}
  cancel(player){for(const s of this.sessions.values())if(s.players.includes(player)){const ending=player===s.host;for(const c of this.peers(s))if(ending||c.player===player)c.ws.close(1008,'party changed');if(ending)this.sessions.delete(s.id);else s.players[s.players.indexOf(player)]=null;}}
  allocate(c,m){
    const party=this.hub.social.party(c.player);if(!party)fail('party_required');if(typeof m.request_id!=='string'||!/^[0-9a-f-]{36}$/i.test(m.request_id))fail('bad_request_id');
    if(!this.hub.social.online(party.leader).length)fail('host_offline');
    let s=[...this.sessions.values()].find(s=>s.party===party.id&&s.host===party.leader);
    if(!s){if(this.sessions.size>=128)fail('busy');let record=this.hub.store.db.prepare('SELECT world FROM relay_worlds WHERE owner=?').get(party.leader);if(!record){record={world:randomUUID()};this.hub.store.db.prepare('INSERT INTO relay_worlds VALUES(?,?)').run(party.leader,record.world);}s={id:randomUUID(),world:record.world,host:party.leader,party:party.id,players:[],epoch:1,activity:Date.now(),build:null};this.sessions.set(s.id,s);}
    if(!s.players.length)s.players=[party.leader];for(const player of party.members)if(!s.players.includes(player)){let seat=s.players.indexOf(null);if(seat<0)seat=s.players.length;if(seat>3)fail('session_full');s.players[seat]=player;}s.activity=Date.now();
    if(this.tickets.size>4096)fail('busy');
    for(const player of s.players){if(!this.hub.social.online(player).length)continue;const ticket=randomBytes(32).toString('base64'),key=sha(ticket).toString('hex');this.tickets.set(key,{player,session:s.id,expires:Date.now()+60000});this.hub.social.send(player,{t:'party.world',request_id:m.request_id,world:s.world,session:s.id,ticket,relay_url:this.hub.url.replace(/^http/,'ws')+'/relay',seat:s.players.indexOf(player),host:this.hub.social.profile(s.host),asked_by:player===s.host&&c.player!==s.host?c.player:null});}
    return true;
  }
  lobby(c,m){if(m.t==='party.world.join')return this.allocate(c,m);if(m.t==='party.world.cancel'){this.cancel(c.player);return true;}return false;}
  authenticate(c,m){
    if(c.phase==='hello'){
      if(m.t!=='hello'||m.pt!==1)fail('version');b64(m.ticket,8192);const hash=sha(m.ticket).toString('hex'),t=this.tickets.get(hash),s=t&&this.sessions.get(t.session);if(!t||!s||t.expires<Date.now()||!s.players.includes(t.player))fail('bad_ticket');if(typeof m.build!=='string'||!m.build.length||m.build.length>128)fail('version');if(s.build&&s.build!==m.build)fail('version');
      c.ticketHash=hash;c.relayTicket=t;c.session=s.id;c.player=t.player;c.build=m.build;c.nonce=randomBytes(32);c.phase='proof';this.hub.send(c,{t:'challenge',nonce:c.nonce.toString('base64')});return;
    }
    if(c.phase!=='proof'||m.t!=='auth')fail('bad_auth');const t=this.tickets.get(c.ticketHash),s=this.sessions.get(c.session);if(!t||!s||t.expires<Date.now()||!s.players.includes(c.player))fail('bad_ticket');
    if(!verify(null,c.nonce,publicKey(b64(this.hub.store.player(c.player).key,32,32)),b64(m.sig,64,64)))fail('bad_proof');if(s.build&&s.build!==c.build)fail('version');
    this.tickets.delete(c.ticketHash);this.hub.store.visit(c.player,'relay',s.world,s.host,this.hub.store.playerInfo(s.host).name+"'s world");s.build=c.build;c.seat=s.players.indexOf(c.player);for(const old of this.peers(s))if(old.player===c.player){old.authenticated=false;old.ws.close(1008,'reconnected');}
    c.authenticated=true;c.phase='ready';c.expires=Date.now()+3600000;c.budget=limits.game_burst_bytes;c.refill=Date.now();s.activity=Date.now();
    this.hub.send(c,{t:'ready',world:s.world,session:s.id,seat:c.seat,epoch:s.epoch,roster:this.roster(s),limits});this.update(s);
  }
  message(c,m){if(m.t==='ping'){if(!Number.isSafeInteger(m.ts))fail('bad_ping');this.hub.send(c,{t:'pong',ts:m.ts});return;}fail('unsupported_message');}
  binary(c,data){
    if(!c.authenticated)fail('not_authenticated');const s=this.sessions.get(c.session);if(!s||!s.players.includes(c.player))fail('session_closed');
    const now=Date.now();c.budget=Math.min(limits.game_burst_bytes,c.budget+(now-c.refill)*limits.game_bytes_per_second/1000);c.refill=now;if(data.length>c.budget)fail('relay_rate_limit');c.budget-=data.length;
    if(now-c.frameWindow>=1000||!c.frameWindow){c.frameWindow=now;c.frameCount=0;}if(++c.frameCount>limits.game_frames_per_second)fail('relay_rate_limit');
    const peers=this.peers(s),r=routeFrame(data,c.seat,peers.map(p=>p.seat));for(const peer of peers)if(r.targets.includes(peer.seat)){if(peer.ws.bufferedAmount>1048576){peer.ws.close(1008,'slow relay consumer');continue;}peer.ws.send(r.wire);}s.activity=now;
  }
  disconnected(c){const s=this.sessions.get(c.session);if(s)this.update(s);}
}
