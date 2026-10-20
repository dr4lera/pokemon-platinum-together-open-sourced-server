import {randomBytes} from 'node:crypto';
import {fail} from './identity.mjs';

// Invite capabilities identify a party only. Account keys and relay tickets never leave their owner.
export class DiscordInvites {
 constructor(hub){this.hub=hub;this.invites=new Map();}
 sweep(){for(const [key,v] of this.invites)if(v.expires<=Date.now()||this.hub.social.parties.get(v.party)?.leader!==v.leader)this.invites.delete(key);}
 create(player){
  this.sweep();const p=this.hub.social.party(player);
  if(!p||p.leader!==player||!this.hub.social.online(player).some(c=>!c.build.startsWith('private-launcher-')))return null;
  const url=new URL(this.hub.url);
  // Loopback/LAN addresses cannot be advertised as Internet invitations.
  if(url.protocol!=='https:'||url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))return null;
  let entry=[...this.invites].find(([,v])=>v.party===p.id&&v.expires>Date.now()+60000);
  if(!entry){if(this.invites.size>=1024)fail('busy');entry=[randomBytes(16).toString('base64url'),{party:p.id,leader:p.leader,expires:Date.now()+600000}];this.invites.set(...entry);}
  const secret=url.origin+'/private/j/'+entry[0];if(Buffer.byteLength(secret)>128)fail('invite_address_too_long');
  return {secret,party:p.id,size:p.members.length,max:4,expires:entry[1].expires};
 }
 resolve(key){
  this.sweep();const v=this.invites.get(key),p=v&&this.hub.social.parties.get(v.party);
  if(!v||!p||p.leader!==v.leader||!this.hub.social.online(p.leader).some(c=>!c.build.startsWith('private-launcher-')))fail('invite_expired');
  return {server:this.hub.url,hub_key:this.hub.identity.pin,party:p.id,code:p.code,name:this.hub.store.playerInfo(p.leader).name,expires:v.expires};
 }
}
