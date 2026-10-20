import {randomInt,randomUUID} from 'node:crypto';
import {fail} from './identity.mjs';
import {text} from './store.mjs';

// The native six-character parser rejects 0, O, 1, I and L.
const PARTY_CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FRIEND_CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ';

// These response shapes are accepted by the actual 0.1.5 native lobby parser.
export class Social {
  constructor(hub){this.hub=hub;this.parties=new Map();this.membership=new Map();this.invites=new Map();}
  online(player){return [...this.hub.connections].filter(c=>c.kind==='lobby'&&c.authenticated&&c.player===player&&c.ws.readyState===1);}
  send(player,m){for(const c of this.online(player))this.hub.send(c,m);}
  profile(player){const t=this.hub.store.trainer(player);if(!t)fail('trainer_required');return {player,name:t.name,look:t.look,outfit:t.outfit,art:this.hub.trainerArt?.profile(player)??null};}
  party(player){return this.parties.get(this.membership.get(player));}
  snapshot(p){return {id:p.id,code:p.code,leader:p.leader,listed:p.listed,busy:false,profile_id:null,members:p.members.map(player=>({...this.profile(player),online:this.online(player).length>0}))};}
  update(p){for(const player of p.members)this.send(player,{t:'party',party:this.snapshot(p)});}
  create(player,lettersOnly=false){this.profile(player);const current=this.party(player);if(current){if(current.leader!==player)fail('already_in_party');return current;}if(this.parties.size>=256)fail('busy');const alphabet=lettersOnly?FRIEND_CODE_ALPHABET:PARTY_CODE_ALPHABET;let code;do{code=Array.from({length:6},()=>alphabet[randomInt(alphabet.length)]).join('');}while([...this.parties.values()].some(p=>p.code===code));const p={id:randomUUID(),code,leader:player,members:[player],listed:false};this.parties.set(p.id,p);this.membership.set(player,p.id);return p;}
  leave(player){const p=this.party(player);if(!p){this.send(player,{t:'party',party:null});return;}this.hub.relay.cancel(player);p.members=p.members.filter(x=>x!==player);this.membership.delete(player);this.send(player,{t:'party',party:null});for(const[k,v]of this.invites)if(v.party===p.id&&(v.from===player||v.to===player))this.invites.delete(k);if(!p.members.length){this.parties.delete(p.id);return;}if(p.leader===player)p.leader=p.members[0];this.update(p);}
  sweep(){for(const[k,v]of this.invites)if(v.expires<Date.now())this.invites.delete(k);}
  connected(c){const p=this.party(c.player);if(p)this.update(p);this.hub.friends.presence(c.player);}
  disconnected(c){this.cityLeave(c,false);const p=this.party(c.player);if(p)this.update(p);this.hub.friends.presence(c.player);}
  cityPlayers(district){return [...this.hub.connections].filter(c=>c.kind==='lobby'&&c.authenticated&&c.city===district&&c.ws.readyState===1);}
  cityPlayer(c){return {...this.profile(c.player),slot:c.citySlot,status:c.presence??'active'};}
  profileChanged(player){
    // A same-player city.add refresh keeps the native peer's valid position
    // while replacing its name/appearance. Do not drop/recreate the avatar.
    for(const source of this.online(player).filter(c=>c.city))for(const peer of this.cityPlayers(source.city))if(peer.player!==player)this.hub.send(peer,{t:'city.add',...this.cityPlayer(source)});
    const party=this.party(player);if(party)this.update(party);
    this.hub.friends.presence(player);
  }
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
      const selector=m.code??m.party;text(selector,64);if(m.code!==undefined&&(m.party!==undefined||!/^[A-HJKMNP-Z2-9]{6}$/.test(m.code)))fail('bad_party_code');const p=this.parties.get(selector)??[...this.parties.values()].find(p=>p.code===selector.toUpperCase());if(!p)fail('party_not_found');const current=this.party(c.player);if(current){if(current.id!==p.id)fail('already_in_party');this.update(p);return true;}this.profile(c.player);
      const invite=this.invites.get(p.id+':'+c.player);if(!p.listed&&p.code!==selector.toUpperCase()&&(!invite||invite.expires<Date.now()))fail('invite_expired');if(p.members.length>=4)fail('party_full');
      this.invites.delete(p.id+':'+c.player);p.members.push(c.player);this.membership.set(c.player,p.id);this.update(p);return true;
    }
    if(m.t==='party.decline'){const p=this.parties.get(m.party);if(!p)fail('party_not_found');const invite=this.invites.get(p.id+':'+c.player);if(!invite||invite.expires<Date.now())fail('invite_expired');this.invites.delete(p.id+':'+c.player);this.send(invite.from,{t:'party.declined',player:c.player});return true;}
    if(m.t==='party.listing'){const p=this.party(c.player);if(!p||p.leader!==c.player)fail('not_leader');if(typeof m.listed!=='boolean'||m.profile_id!==null)fail('unsupported_profile');p.listed=m.listed;this.update(p);return true;}
    return false;
  }
}
