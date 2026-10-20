import {fail} from './identity.mjs';

export const normalizeFriendCode=value=>{
 if(typeof value!=='string'||value.length>32)fail('bad_party_code');
 const code=value.trim().toUpperCase();if(!/^[A-HJKMNP-Z2-9]{6}$/.test(code))fail('bad_party_code');return code;
};

// Optional launcher flow over the existing authenticated native party protocol.
// A code selects a party on one server; it never allocates a world or relay seat.
export class FriendCodes {
 constructor(hub){this.hub=hub;}
 handle(c,m){
  if(!['private.friend-code.create','private.friend-code.join'].includes(m.t))return false;
  if(!this.hub.features.friend_codes)fail('friend_codes_disabled');
  if(m.t==='private.friend-code.create'){
   const party=this.hub.social.create(c.player,true);this.hub.social.update(party);
  }else this.hub.social.handle(c,{t:'party.join',code:normalizeFriendCode(m.code)});
  const p=this.hub.social.party(c.player);
  this.hub.send(c,{t:'private.friend-code',action:m.t.endsWith('.create')?'create':'join',
   invite:{server:this.hub.url,hub_key:this.hub.identity.pin,party:p.id,code:p.code,
    host:this.hub.store.playerInfo(p.leader).name,size:p.members.length,max:4}});
  return true;
 }
}
