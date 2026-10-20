// Original own-client, ephemeral wireless transport. It is not a world relay.
import {randomBytes,randomUUID} from 'node:crypto';
import {b64,sha,fail,checkProof} from './identity.mjs';
import {TokenBucket,TrafficWindow} from './elapsed-limits.mjs';
import {routeFrame} from './frames.mjs';

export const COMMUNITY_LINK_LIMITS=Object.freeze({payload_bytes:8192,frames_per_second:120,bytes_per_second:262144,burst_bytes:262144,buffered_bytes:1048576,ticket_ms:30000,join_ms:30000,session_ms:1800000});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)?value:fail('link_bad_request_id');
export function communityLinkFingerprint(m){
  if(typeof m.build!=='string'||!/^community-client-[A-Za-z0-9._-]{1,100}$/.test(m.build))fail('link_bad_build');
  if(typeof m.catalog!=='string'||!/^[a-f0-9]{64}$/.test(m.catalog)||typeof m.rules!=='string'||!/^[a-f0-9]{64}$/.test(m.rules))fail('link_bad_fingerprint');
  return {build:m.build,catalog:m.catalog,rules:m.rules};
}
const same=(a,b)=>!!a&&!!b&&a.build===b.build&&a.catalog===b.catalog&&a.rules===b.rules;
const hashTicket=ticket=>sha(b64(ticket,32,32)).toString('hex');
// Fixed-position JSON array, UTF-8, no insignificant whitespace. Public keys
// and the full frozen roster hash are part of the signed account binding.
export function communityLinkTail(offer){
  return sha(Buffer.from(JSON.stringify([1,offer.session,offer.epoch,offer.party,offer.player,offer.key,offer.seat,offer.build,offer.catalog,offer.rules,offer.roster_hash,hashTicket(offer.ticket)]),'utf8'));
}

export class CommunityLink {
  constructor(hub){this.hub=hub;this.sessions=new Map();this.tickets=new Map();this.requests=new Map();this.epoch=0;}
  enabled(){if(this.hub.role!=='combined')fail('link_combined_server_required');if(!this.hub.features.community_link)fail('link_disabled');}
  peers(s){return [...this.hub.connections].filter(c=>c.kind==='community-link'&&c.authenticated&&c.session===s.id&&c.ws.readyState===1);}
  descriptor(s){return {session:s.id,epoch:s.epoch,party:s.party,...s.fingerprint,roster:s.members.map(({seat,player,key,mac})=>({seat,player,key,mac})),roster_hash:s.rosterHash,expires_at_ms:s.expires};}
  valid(s){
    const party=this.hub.social.parties.get(s.party);
    if(!party||party.leader!==s.leader||party.members.length!==s.members.length||party.members.some((player,i)=>player!==s.members[i].player))return false;
    return s.members.every(member=>{
      const c=member.lobby;
      try{return this.hub.connections.has(c)&&c.kind==='lobby'&&c.authenticated&&c.ws.readyState===1&&c.expires>Date.now()&&c.player===member.player&&c.account.key.toString('base64')===member.key&&c.build===s.fingerprint.build&&same(c.communityLinkPrepared,s.fingerprint)&&this.hub.store.player(member.player).key===member.key;}catch{return false;}
    });
  }
  requireSession(c){const s=this.sessions.get(c.session);if(s&&s.expires<=Date.now()){this.end(s,'session_expired');fail('link_session_closed');}if(!s||!this.valid(s)){if(s)this.end(s,'identity_changed');fail('link_session_closed');}return s;}
  notify(s,m){for(const member of s.members)this.hub.send(member.lobby,m);for(const c of this.peers(s))this.hub.send(c,m);}
  state(s){this.notify(s,{t:'community.link.peers',session:s.id,epoch:s.epoch,active:s.started,connected:this.peers(s).map(c=>c.seat)});}
  offer(s,member){return {t:'community.link.offer',pt:1,...this.descriptor(s),player:member.player,key:member.key,seat:member.seat,ticket:member.ticket,ticket_expires_at_ms:member.ticketExpires,link_url:this.hub.url.replace(/^http/,'ws')+'/community-link'};}
  issue(s,member){
    if(member.ticket)this.tickets.delete(hashTicket(member.ticket));
    member.ticket=randomBytes(32).toString('base64');member.ticketExpires=Math.min(Date.now()+COMMUNITY_LINK_LIMITS.ticket_ms,s.joinDeadline);
    this.tickets.set(hashTicket(member.ticket),{session:s.id,member,expires:member.ticketExpires,claimed:null});
    this.hub.send(member.lobby,this.offer(s,member));
  }
  end(s,reason){
    if(!this.sessions.delete(s.id))return;
    for(const [key,t] of this.tickets)if(t.session===s.id)this.tickets.delete(key);
    this.notify(s,{t:'community.link.ended',session:s.id,epoch:s.epoch,reason});
    for(const c of this.peers(s)){c.authenticated=false;c.ws.close(1008,'link session ended');}
    const request=this.requests.get(s.leader+':'+s.requestId);if(request)request.expires=Date.now()+120000;
  }
  reconcile(){for(const s of this.sessions.values())if(!this.valid(s))this.end(s,'identity_changed');}
  sweep(){
    this.reconcile();const now=Date.now();
    for(const [key,t] of this.tickets)if(t.expires<=now)this.tickets.delete(key);
    for(const s of this.sessions.values())if(s.expires<=now||(!s.started&&s.joinDeadline<=now))this.end(s,s.started?'session_expired':'join_expired');
    for(const [key,r] of this.requests)if(!this.sessions.has(r.session)&&r.expires<=now)this.requests.delete(key);
  }
  lobby(c,m){
    if(!m.t.startsWith('community.link.'))return false;
    this.enabled();this.reconcile();
    c.communityLinkControl??=new TokenBucket(1,8);if(!c.communityLinkControl.allow(1))fail('link_control_rate_limit');
    if(m.t==='community.link.prepare'){
      const fingerprint=communityLinkFingerprint(m);if(c.build!==fingerprint.build)fail('link_build_mismatch');
      c.communityLinkPrepared=fingerprint;this.reconcile();this.hub.send(c,{t:'community.link.prepared',...fingerprint});return true;
    }
    const party=this.hub.social.party(c.player);if(!party)fail('party_required');
    if(m.t==='community.link.open'){
      const requestId=uuid(m.request_id);if(party.leader!==c.player)fail('not_leader');
      const requestKey=c.player+':'+requestId,prior=this.requests.get(requestKey);
      if(prior){const s=this.sessions.get(prior.session);if(!s||s.members[0].lobby!==c)fail('link_request_closed');this.hub.send(c,this.offer(s,s.members[0]));return true;}
      if([...this.sessions.values()].some(s=>s.party===party.id))fail('link_session_active');
      if(party.members.length<2||party.members.length>4)fail('link_party_size');
      if(this.sessions.size>=128||this.requests.size>=1024)fail('link_busy');
      const fingerprint=c.communityLinkPrepared;if(!fingerprint)fail('link_not_prepared');
      const members=party.members.map((player,seat)=>{
        const candidates=this.hub.social.online(player).filter(peer=>peer.expires>Date.now()&&peer.build===fingerprint.build&&same(peer.communityLinkPrepared,fingerprint));
        if(candidates.length!==1||(seat===0&&candidates[0]!==c))fail(candidates.length>1?'link_ambiguous_lobby':'link_incompatible_member');
        const key=this.hub.store.player(player).key;if(candidates[0].account.key.toString('base64')!==key)fail('link_identity_mismatch');return {seat,player,key,lobby:candidates[0]};
      });
      // Keep an independent hard deadline. valid() checks the bound lobbies'
      // current signed credentials, so routine same-key renewal must not leave
      // an obsolete token expiry scheduled to interrupt a native trade/battle.
      const now=Date.now(),s={id:randomUUID(),epoch:++this.epoch,party:party.id,leader:party.leader,requestId,fingerprint,members,started:false,joinDeadline:now+COMMUNITY_LINK_LIMITS.join_ms,expires:now+COMMUNITY_LINK_LIMITS.session_ms};
      for(const member of members){const mac=Buffer.from(sha(Buffer.from(s.id+'\0'+member.player)).subarray(0,6));mac[0]=(mac[0]|2)&254;member.mac=mac.toString('hex');}
      s.rosterHash=sha(Buffer.from(JSON.stringify(members.map(({seat,player,key,mac})=>({seat,player,key,mac}))))).toString('hex');
      this.sessions.set(s.id,s);this.requests.set(requestKey,{session:s.id,expires:s.expires+120000});
      for(const member of members)this.issue(s,member);return true;
    }
    if(m.t==='community.link.cancel'){
      const s=[...this.sessions.values()].find(s=>s.party===party.id);if(!s)fail('link_session_closed');
      if(!s.members.some(member=>member.lobby===c))fail('link_wrong_lobby');this.end(s,'cancelled');return true;
    }
    if(m.t==='community.link.ticket'){
      const s=this.sessions.get(m.session);if(!s||s.party!==party.id||m.epoch!==s.epoch)fail('link_session_closed');
      const member=s.members.find(member=>member.lobby===c);if(!member)fail('link_wrong_lobby');
      if(s.started||this.peers(s).some(peer=>peer.player===c.player)||Date.now()>=s.joinDeadline)fail('link_already_attached');this.issue(s,member);return true;
    }
    fail('unsupported_message');
  }
  authenticate(c,m){
    this.enabled();
    if(c.phase==='hello'){
      if(m.t!=='community.link.hello'||m.pt!==1)fail('link_version');
      const hash=hashTicket(m.ticket),t=this.tickets.get(hash),s=t&&this.sessions.get(t.session);
      if(!t||!s||t.claimed||t.expires<=Date.now())fail('link_bad_ticket');
      if(!this.valid(s)){this.end(s,'identity_changed');fail('link_session_closed');}
      if(m.session!==s.id||m.epoch!==s.epoch||!same(communityLinkFingerprint(m),s.fingerprint))fail('link_identity_mismatch');
      t.claimed=c.id;c.linkTicketHash=hash;c.session=s.id;c.player=t.member.player;c.seat=t.member.seat;c.nonce=randomBytes(32);c.phase='proof';c.expires=Math.min(t.expires,Date.now()+5000);
      this.hub.send(c,{t:'community.link.challenge',nonce:c.nonce.toString('base64'),session:s.id,epoch:s.epoch});return;
    }
    if(c.phase!=='proof'||m.t!=='auth')fail('bad_auth');
    const s=this.requireSession(c),t=this.tickets.get(c.linkTicketHash);
    if(!t||t.claimed!==c.id||t.expires<=Date.now()||c.expires<=Date.now())fail('link_bad_ticket');
    checkProof(b64(t.member.key,32,32),'PT-COMMUNITY-LINK',c.nonce,communityLinkTail(this.offer(s,t.member)),m.sig);
    this.tickets.delete(c.linkTicketHash);c.authenticated=true;c.phase='ready';c.expires=s.expires;c.linkBytes=new TokenBucket(COMMUNITY_LINK_LIMITS.bytes_per_second,COMMUNITY_LINK_LIMITS.burst_bytes);c.linkFrames=new TrafficWindow(COMMUNITY_LINK_LIMITS.frames_per_second,Infinity);
    if(this.peers(s).length===s.members.length)s.started=true;
    this.hub.send(c,{t:'community.link.ready',pt:1,...this.descriptor(s),seat:c.seat,active:s.started,limits:COMMUNITY_LINK_LIMITS});this.state(s);
  }
  message(c,m){this.requireSession(c);if(m.t==='ping'){if(!Number.isSafeInteger(m.ts)||m.ts<0)fail('bad_ping');this.hub.send(c,{t:'pong',ts:m.ts});return;}if(m.t==='community.link.leave'){this.end(this.requireSession(c),'peer_left');return;}fail('unsupported_message');}
  binary(c,data){
    if(!c.authenticated)fail('not_authenticated');const s=this.requireSession(c);if(!s.started)fail('link_not_ready');
    if(!Buffer.isBuffer(data)||data.length<3||data.length>COMMUNITY_LINK_LIMITS.payload_bytes+2)fail('link_bad_frame');
    if(!c.linkBytes.allow(data.length)||!c.linkFrames.allow(data.length))fail('link_rate_limit');
    const peers=this.peers(s),destination=data[1];if(peers.length!==s.members.length)fail('link_session_closed');
    if(destination===c.seat||(destination!==255&&!peers.some(peer=>peer.seat===destination)))fail('link_bad_destination');
    const {targets,wire}=routeFrame(data,c.seat,peers.map(peer=>peer.seat)),receivers=peers.filter(peer=>targets.includes(peer.seat));
    if(receivers.some(peer=>peer.ws.bufferedAmount+wire.length>COMMUNITY_LINK_LIMITS.buffered_bytes))fail('link_slow_consumer');
    for(const peer of receivers)peer.ws.send(wire,{binary:true});
  }
  rejected(c,error){
    this.hub.send(c,{t:'err',code:error.code??'bad_message',fatal:true});
    if(c.authenticated){const s=this.sessions.get(c.session);if(s)this.end(s,error.code==='link_slow_consumer'?'slow_consumer':'protocol_error');}
    else if(c.linkTicketHash&&this.tickets.get(c.linkTicketHash)?.claimed===c.id)this.tickets.delete(c.linkTicketHash);
    c.ws.close(1008,'link rejected');
  }
  disconnected(c){
    if(c.kind==='community-link'){
      if(c.authenticated){const s=this.sessions.get(c.session);if(s){this.notify(s,{t:'community.link.peer_left',session:s.id,epoch:s.epoch,seat:c.seat,player:c.player,reason:'disconnected'});this.end(s,'peer_disconnected');}}
      else if(c.linkTicketHash&&this.tickets.get(c.linkTicketHash)?.claimed===c.id)this.tickets.delete(c.linkTicketHash);
    }else if(c.kind==='lobby')for(const s of this.sessions.values())if(s.members.some(member=>member.lobby===c))this.end(s,'lobby_disconnected');
  }
}
