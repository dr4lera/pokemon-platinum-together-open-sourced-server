import {randomBytes,randomUUID} from 'node:crypto';
import {fail} from './identity.mjs';
import {text} from './store.mjs';

// These response shapes are accepted by the actual 0.1.5 native lobby parser.
export class Social {
  constructor(hub){this.hub=hub;this.parties=new Map();this.membership=new Map();this.invites=new Map();}
  online(player){return [...this.hub.connections].filter(c=>c.kind==='lobby'&&c.authenticated&&c.player===player&&c.ws.readyState===1);}
  send(player,m){for(const c of this.online(player))this.hub.send(c,m);}
  profile(player){const t=this.hub.store.trainer(player);if(!t)fail('trainer_required');return {player,name:t.name,look:t.look,outfit:t.outfit};}
  party(player){return this.parties.get(this.membership.get(player));}
  snapshot(p){return {id:p.id,code:p.code,leader:p.leader,listed:p.listed,busy:false,profile_id:null,members:p.members.map(player=>({...this.profile(player),online:this.online(player).length>0}))};}
  update(p){for(const player of p.members)this.send(player,{t:'party',party:this.snapshot(p)});}
  create(player){this.profile(player);if(this.party(player))fail('already_in_party');if(this.parties.size>=256)fail('busy');let code;do{code=randomBytes(4).toString('hex').slice(0,6).toUpperCase();}while([...this.parties.values()].some(p=>p.code===code));const p={id:randomUUID(),code,leader:player,members:[player],listed:false};this.parties.set(p.id,p);this.membership.set(player,p.id);return p;}
  leave(player){const p=this.party(player);if(!p){this.send(player,{t:'party',party:null});return;}this.hub.relay.cancel(player);p.members=p.members.filter(x=>x!==player);this.membership.delete(player);this.send(player,{t:'party',party:null});for(const[k,v]of this.invites)if(v.party===p.id&&(v.from===player||v.to===player))this.invites.delete(k);if(!p.members.length){this.parties.delete(p.id);return;}if(p.leader===player)p.leader=p.members[0];this.update(p);}
  sweep(){for(const[k,v]of this.invites)if(v.expires<Date.now())this.invites.delete(k);}
  connected(c){const p=this.party(c.player);if(p)this.update(p);this.hub.friends.presence(c.player);}
  disconnected(c){this.cityLeave(c,false);const p=this.party(c.player);if(p)this.update(p);this.hub.friends.presence(c.player);}
  cityPlayers(district){return [...this.hub.connections].filter(c=>c.kind==='lobby'&&c.authenticated&&c.city===district&&c.ws.readyState===1);}
  cityPlayer(c){return {...this.profile(c.player),slot:c.citySlot,status:c.presence??'active'};}
  cityLeave(c,reply=true){if(c.city){const district=c.city,slot=c.citySlot;delete c.city;delete c.citySlot;for(const peer of this.cityPlayers(district))this.hub.send(peer,{t:'city.drop',slot});}if(reply)this.hub.send(c,{t:'city.left',reason:'left'});}
  handle(c,m){
    if(m.t==='city.enter'){
      if(m.district!=='plaza')fail('unknown_district');this.profile(c.player);this.cityLeave(c,false);const peers=this.cityPlayers(m.district);const slots=new Set(peers.map(x=>x.citySlot));let slot=0;while(slots.has(slot))slot++;if(slot>=64)fail('city_full');
      c.city=m.district;c.citySlot=slot;c.presence='active';this.hub.send(c,{t:'city.joined',district:m.district,instance:'private-plaza',cap:64,slot,players:peers.map(x=>this.cityPlayer(x)),news:[]});for(const peer of peers)this.hub.send(peer,{t:'city.add',...this.cityPlayer(c)});return true;
    }
    if(m.t==='city.leave'){this.cityLeave(c);return true;}
    if(m.t==='city.status'){if(!c.city)fail('not_in_city');if(!['active','menu','away','afk'].includes(m.status))fail('bad_status');c.presence=m.status;for(const peer of this.cityPlayers(c.city))if(peer!==c)this.hub.send(peer,{t:'city.status',slot:c.citySlot,status:c.presence});return true;}
    if(m.t==='party.create'){this.update(this.create(c.player));return true;}
    if(m.t==='party.leave'){this.leave(c.player);return true;}
    if(m.t==='party.invite'){
      let target=m.player;
      if(!target&&m.username){target=String(this.hub.friends.lookup(m.username).id);}
      text(target,20);if(target===c.player)fail('cannot_invite_self');if(!this.online(target).length)fail('player_offline');this.profile(target);if(this.party(target))fail('already_in_party');
      const p=this.party(c.player)??this.create(c.player);if(p.leader!==c.player)fail('not_leader');if(p.members.length>=4)fail('party_full');
      const key=p.id+':'+target,previous=this.invites.get(key);if(previous&&previous.expires>Date.now()+55000)fail('invite_pending');if(this.invites.size>=2048)fail('busy');
      const invite={party:p.id,from:c.player,to:target,expires:Date.now()+60000};this.invites.set(key,invite);this.update(p);this.send(target,{t:'party.invited',party:p.id,from:this.profile(c.player),members:p.members.length,expires_ms:invite.expires,server_ms:Date.now()});this.hub.send(c,{t:'party.invite.sent',player:target});return true;
    }
    if(m.t==='party.join'){
      text(m.party,64);const p=this.parties.get(m.party)??[...this.parties.values()].find(p=>p.code===m.party.toUpperCase());if(!p)fail('party_not_found');if(this.party(c.player))fail('already_in_party');this.profile(c.player);
      const invite=this.invites.get(p.id+':'+c.player);if(!p.listed&&p.code!==m.party.toUpperCase()&&(!invite||invite.expires<Date.now()))fail('invite_expired');if(p.members.length>=4)fail('party_full');
      this.invites.delete(p.id+':'+c.player);p.members.push(c.player);this.membership.set(c.player,p.id);this.update(p);return true;
    }
    if(m.t==='party.decline'){const p=this.parties.get(m.party);if(!p)fail('party_not_found');const invite=this.invites.get(p.id+':'+c.player);if(!invite||invite.expires<Date.now())fail('invite_expired');this.invites.delete(p.id+':'+c.player);this.send(invite.from,{t:'party.declined',player:c.player});return true;}
    if(m.t==='party.listing'){const p=this.party(c.player);if(!p||p.leader!==c.player)fail('not_leader');if(typeof m.listed!=='boolean'||m.profile_id!==null)fail('unsupported_profile');p.listed=m.listed;this.update(p);return true;}
    return false;
  }
}
