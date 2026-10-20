import {TrafficWindow} from './elapsed-limits.mjs';
import {createServer} from 'node:http';
import {mkdirSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {WebSocketServer} from './vendor/ws/wrapper.mjs';
import {Store, text, integer, pairs} from './store.mjs';
import {loadIdentity, issueToken, readToken, checkProof, b64, sha, fail, secret} from './identity.mjs';
import {routeFrame,cityFrame} from './frames.mjs';
import {Social} from './social.mjs';
import {Friends} from './friends.mjs';
import {renew} from './refresh.mjs';
import {renewLobby} from './lobby-renew.mjs';
import {Chat} from './chat.mjs';
import {Control} from './control.mjs';
import {Accounts} from './accounts.mjs';
import {Mail} from './mail.mjs';
import {Relay} from './relay.mjs';
import {CommunityLink} from './community-link.mjs';
import {CustomGifts} from './custom-gifts.mjs';
import {Moderation} from './moderation.mjs';
import {Plugins} from './plugins.mjs';
import {DiscordInvites} from './discord-invites.mjs';
import {FriendCodes} from './friend-codes.mjs';
import {TrainerArt,MAX_TRAINER_ART_REQUEST_BYTES} from './trainer-art.mjs';

const LIMITS={game_frames_per_second:120,game_bytes_per_second:262144,game_burst_bytes:524288};
const FEATURES={realms:true,city:true,adventures:false,runs:false,player_worlds:false,offline_catches:false,trading:false,public_pvp:false,social:true};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)?v:fail('bad_op');
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:fail('bad_hash');
const ticketHash=v=>sha(b64(v,32,32)).toString('hex');

export class Hub {
  constructor({dir,port=8787,host='127.0.0.1',publicUrl,log=true,name='Platinum Private Worlds',role='combined',trustedLoopbackProxy,pluginsEnabled=true,pluginDirectory,friendCodesEnabled=false,communityLinkEnabled=false}={}) {
    if(!dir)throw new Error('A data directory is required');
    if(!['combined','inverna','world'].includes(role))throw new Error('Invalid server role');
    // Ordinary 0.1.5 clients can enter relay co-op through Menu > Party >
    // Join World. Persistent world and Inverna deployments remain separate.
    if(typeof friendCodesEnabled!=='boolean')throw new Error('friendCodesEnabled must be boolean');
    if(typeof communityLinkEnabled!=='boolean')throw new Error('communityLinkEnabled must be boolean');
    this.role=role;this.features={...FEATURES,city:role!=='world',realms:role!=='inverna',player_worlds:role==='combined',friend_codes:friendCodesEnabled&&role!=='world',community_link:communityLinkEnabled&&role==='combined'};
    mkdirSync(dir,{recursive:true});this.dir=dir;this.port=port;this.host=host;this.publicUrl=publicUrl;this.logging=log;this.name=name;this.pluginsEnabled=pluginsEnabled;this.pluginDirectory=pluginDirectory;
    this.store=new Store(join(dir,'worlds.sqlite'));this.identity=loadIdentity(dir);
    this.trainerArt=new TrainerArt(this);
    this.connections=new Set();this.tickets=new Map();this.transfers=new Map();this.builds=new Map();
    this.trustedProxy=trustedLoopbackProxy??(this.store.db.prepare("SELECT value FROM server_settings WHERE name='trusted_loopback_proxy'").get()?.value==='1');
    this.moderation=new Moderation(this);
    this.plugins=new Plugins(this);
    this.social=new Social(this);
    this.discordInvites=new DiscordInvites(this);
    this.friendCodes=new FriendCodes(this);
    this.friends=new Friends(this);
    this.chat=new Chat(this);
    this.control=new Control(this);
    this.accounts=new Accounts(this);
    this.mail=new Mail(this);
    this.customGifts=new CustomGifts(this);
    this.relay=new Relay(this);
    this.communityLink=new CommunityLink(this);
    this.http=createServer((req,res)=>this.request(req,res));
    this.ws=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
    this.http.on('upgrade',(req,socket,head)=>{
      const path=new URL(req.url,'http://localhost').pathname;
      let clientAddress;try{clientAddress=this.moderation.address(req);}catch{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;}
      if(this.moderation.blockedIp(clientAddress)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
      // Paths are explicit; native client's exact lobby suffix remains under verification.
      if(!['/','/lobby','/lobby/ws','/ws','/realm','/realm/ws','/relay','/community-link'].includes(path)||(path==='/community-link'&&!this.features.community_link)){socket.end('HTTP/1.1 404 Not Found\r\n\r\n');return;}
      this.ws.handleUpgrade(req,socket,head,ws=>this.connected(ws,path==='/community-link'?'community-link':path==='/relay'?'relay':path.startsWith('/realm')?'realm':'lobby',clientAddress));
    });
  }
  log(event,details={}) {
    if(!this.logging)return;
    // Never log tokens, keys, signatures, raw save bodies, or URL query strings.
    appendFileSync(join(this.dir,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),event,...details})+'\n');
  }
  async start(){await this.plugins.start();await new Promise((resolve,reject)=>{this.http.once('error',reject);this.http.listen(this.port,this.host,resolve);});this.port=this.http.address().port;this.url=this.publicUrl??`http://127.0.0.1:${this.port}`;this.log('started',{port:this.port});this.plugins.emit('server.started',{url:this.url});this.timer=setInterval(()=>this.sweep(),1000);this.timer.unref();return this;}
  close(){this.closePromise??=this.shutdown();return this.closePromise;}
  async shutdown(){clearInterval(this.timer);await this.plugins.close();for(const c of this.connections)c.ws.terminate();await new Promise(resolve=>this.ws.close(resolve));await new Promise(resolve=>this.http.close(resolve));this.store.close();}
  sweep(){this.relay.sweep();this.communityLink.sweep();this.social.sweep();const now=Date.now();for(const [k,v] of this.tickets)if(v.expires<now)this.tickets.delete(k);for(const [k,v] of this.transfers)if(v.expires<now)this.transfers.delete(k);for(const c of this.connections){if(c.expires<now||now-c.activity>90000)c.ws.close(1008,'expired');}}
  credentials(player,refresh=true){const p=this.store.player(player);const r={...issueToken(this.identity,player,p.key),display_name:p.name,features:this.features};if(refresh){r.refresh_token=secret();this.store.db.prepare('INSERT INTO refresh(hash,player,expires) VALUES(?,?,?)').run(sha(r.refresh_token).toString('hex'),player,Date.now()+30*86400000);}return r;}
  enroll(name,key){const p=this.store.enroll(name,key);return this.credentials(String(p.id));}
  async request(req,res){
    const path=new URL(req.url,'http://localhost').pathname;
    const loggedPath=path.startsWith('/private/j/')?'/private/j/[invite]':path;
    this.log('http_request',{method:req.method,path:loggedPath});
    const send=(status,obj)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj));};
    try{
      if(!['/private/server-info','/private/control/challenge','/private/control'].includes(path)&&this.moderation.blockedIp(this.moderation.address(req)))return send(403,{error:'ip_banned'});
      if(req.method==='GET'&&path==='/health')return send(200,{status:'development',protocol:2,realm_protocol:1,players:this.connections.size,worlds:this.store.db.prepare('SELECT COUNT(*) AS n FROM realms').get().n,dedicated_simulation:false,native_client_verified:this.role==='combined',native_verification:{source:'user-confirmed',game:'0.1.7',role:'combined',scope:['gameplay','friend battles','trading']}});
      if(req.method==='GET'&&path==='/v1/public/capacity')return send(200,{version:1,as_of_ms:Date.now(),status:'open',public_players_online:[...this.connections].filter(c=>c.authenticated&&c.kind==='lobby').length});
      if(req.method==='GET'&&path==='/private/server-info')return send(200,{name:this.name,role:this.role,hub:this.url,hub_key:this.identity.pin,account_protocol:1,backend_revision:6,friend_code_protocol:1,trainer_art_protocol:1,world_history_protocol:1,discord_invite_protocol:1,relay_protocol:1,mail_protocol:1,moderation_protocol:1,trusted_loopback_proxy:this.trustedProxy,bind:this.host,port:this.port,features:this.features});
      if(req.method==='GET'&&path==='/private/trainer-art/challenge')return send(200,this.trainerArt.challenge());
      if(req.method==='POST'&&path==='/private/trainer-art'){
        const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>MAX_TRAINER_ART_REQUEST_BYTES)fail('too_large');parts.push(part);}
        return send(200,this.trainerArt.request(JSON.parse(Buffer.concat(parts).toString('utf8'))));
      }
      const artCollection=/^\/api\/creators\/v1\/game\/players\/([1-9][0-9]{0,18})\/trainers$/.exec(path);
      if(req.method==='GET'&&artCollection)return send(200,this.trainerArt.collection(artCollection[1]));
      const artPack=/^\/api\/creators\/v1\/packs\/([a-f0-9]{64})\.pttrainer$/.exec(path);
      if(req.method==='GET'&&artPack){const pack=this.trainerArt.pack(artPack[1]);res.writeHead(200,{'Content-Type':pack.contentType,'Content-Length':pack.bytes.length,'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});res.end(pack.bytes);return;}
      if(req.method==='GET'&&/^\/private\/j\/[A-Za-z0-9_-]{22}$/.test(path))return send(200,this.discordInvites.resolve(path.split('/').at(-1)));
      if(req.method==='POST'&&['/auth/account/challenge','/auth/account'].includes(path)){
        let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>4096)fail('too_large');}
        const m=JSON.parse(body);return send(200,path.endsWith('/challenge')?this.accounts.challenge(req,m):this.accounts.finish(req,m));
      }
      if(req.method==='GET'&&path==='/private/control/challenge')return send(200,this.control.challenge(req));
      if(req.method==='GET'&&path==='/private/mail/challenge')return send(200,this.mail.challenge(req));
      if(req.method==='GET'&&path==='/private/inbox/challenge')return send(200,this.customGifts.challenge());
      if(req.method==='POST'&&path==='/private/inbox'){
        let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>8192)fail('too_large');}
        return send(200,this.customGifts.request(JSON.parse(body)));
      }
      if(req.method==='POST'&&path==='/private/mail'){
        let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>20000)fail('too_large');}
        return send(200,this.mail.admin(req,JSON.parse(body)));
      }
      if(req.method==='POST'&&path==='/private/control'){
        let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>4096)fail('too_large');}
        const reply=await this.control.shutdown(req,JSON.parse(body));if(reply.action==='shutdown')res.once('finish',()=>{this.log('owner_shutdown');this.close().catch(()=>{process.exitCode=1;});});send(200,reply);return;
      }
      if(req.method==='POST'&&path==='/auth/refresh'){
        let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>8192)fail('too_large');}
        return send(200,renew(this,JSON.parse(body)));
      }
      if(req.method==='POST'&&path==='/private/refresh'){
        let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>8192)fail('too_large');}
        const m=JSON.parse(body),r=this.store.db.prepare('SELECT * FROM refresh WHERE hash=?').get(sha(text(m.refresh_token,43)).toString('hex'));
        if(!r||r.expires<Date.now())fail('bad_refresh');const p=this.store.player(String(r.player));
        // Private adapter flow, distinct from native PT2-REFRESH's UUID proof.
        const nonce=b64(m.nonce,32,32),stamp=integer(m.server_ms,0,Number.MAX_SAFE_INTEGER);
        if(Math.abs(Date.now()-stamp)>30000)fail('stale_proof');
        const tail=sha(Buffer.from(m.refresh_token+'\0'+stamp));checkProof(b64(p.key,32,32),'PT-PRIVATE-REFRESH',nonce,tail,m.sig);
        const response=this.store.tx(()=>{const removed=this.store.db.prepare('DELETE FROM refresh WHERE hash=?').run(r.hash);if(removed.changes!==1)fail('bad_refresh');return this.credentials(String(r.player));});return send(200,response);
      }
      send(404,{error:'unsupported_route'});
    }catch(e){this.log('http_rejected',{path:loggedPath,code:e.code??'bad_request'});send(400,{error:e.code??'bad_request'});}
  }
  connected(ws,kind,ip='127.0.0.1'){
    const c={id:randomUUID(),kind,ws,ip,activity:Date.now(),expires:Date.now()+15000,authenticated:false,phase:'hello',traffic:new TrafficWindow(240,LIMITS.game_burst_bytes)};this.connections.add(c);
    ws.on('error',()=>{});
    ws.on('close',()=>{this.connections.delete(c);this.communityLink.disconnected(c);if(c.kind==='relay')this.relay.disconnected(c);if(c.authenticated&&c.kind==='lobby')this.social.disconnected(c);if(c.realm){for(const [k,t]of this.transfers)if(t.connection===c.id)this.transfers.delete(k);this.roster(c.realm);}this.log('disconnected',{connection:c.id,kind,player:c.player});if(c.authenticated)this.plugins.emit('player.disconnected',{player:c.player});});
    ws.on('message',(data,binary)=>{
      try{
        c.activity=Date.now();if(!c.traffic.allow(data.length))fail('rate_limit');
        if(c.authenticated)this.store.player(c.player);
        if(binary){if(c.kind==='community-link')this.communityLink.binary(c,data);else if(c.kind==='relay')this.relay.binary(c,data);else this.binary(c,data);return;}
        const m=JSON.parse(data.toString());if(!m||Array.isArray(m)||typeof m.t!=='string')fail('bad_message');
        this.log('message',{connection:c.id,kind,type:m.t,player:c.player,realm:c.realm});
        if(c.kind==='community-link'){if(!c.authenticated)this.communityLink.authenticate(c,m);else this.communityLink.message(c,m);}else if(c.kind==='relay'){if(!c.authenticated)this.relay.authenticate(c,m);else this.relay.message(c,m);}else if(!c.authenticated)this.authenticate(c,m);else if(c.kind==='lobby'){this.lobby(c,m);this.communityLink.reconcile();}else this.realm(c,m);
      }catch(e){this.log('rejected',{connection:c.id,code:e.code??'bad_message'});if(c.kind==='community-link')this.communityLink.rejected(c,e);else{this.send(c,{t:'err',code:e.code??'bad_message',fatal:!c.authenticated});if(!c.authenticated)c.ws.close(1008,'authentication failed');}}
    });
  }
  send(c,m){if(c.ws.readyState===1){if(c.ws.bufferedAmount>2097152){c.ws.close(1008,'slow consumer');return;}c.ws.send(JSON.stringify(m));}}
  authenticate(c,m){
    if(c.phase==='hello'){
      if(c.kind==='lobby'){
        if(m.t!=='lobby.hello'||m.pt!==2)fail('version');c.account=readToken(this.identity,m.token);const p=this.store.player(c.account.player);if(p.key!==c.account.key.toString('base64'))fail('bad_token');
        c.player=c.account.player;c.tail=sha(c.account.bytes);c.domain='PT2-LOBBY';
      }else{
        if(m.t!=='hello'||m.pt!==1)fail('version');const ticket=b64(m.ticket,32,32);const t=this.tickets.get(ticketHash(m.ticket));if(!t||t.expires<Date.now())fail('ticket_expired');
        c.ticket=t;c.player=t.player;c.realm=t.realm;c.tail=ticket;c.domain='PT-REALM';c.account={key:b64(this.store.player(t.player).key,32,32),expires:Date.now()+3600000};
      }
      c.build=text(m.build,128);c.nonce=randomBytes(32);c.phase='proof';this.send(c,{t:'challenge',nonce:c.nonce.toString('base64')});return;
    }
    if(m.t!=='auth'||c.phase!=='proof')fail('bad_auth');
    checkProof(c.account.key,c.domain,c.nonce,c.tail,m.sig);
    if(c.kind==='realm'&&(!this.tickets.has(c.ticket.hash)||(this.builds.has(c.realm)&&this.builds.get(c.realm)!==c.build)))fail('bad_ticket');
    c.authenticated=true;c.phase='ready';c.expires=c.account.expires;
    if(c.kind==='lobby'){this.send(c,{t:'lobby.ready',player:c.player,expires_at_ms:c.expires,server_ms:Date.now(),features:this.features});this.social.connected(c);this.plugins.emit('player.connected',{player:c.player,username:this.store.playerInfo(c.player).name});}
    else{
      this.tickets.delete(c.ticket.hash);
      const r=this.store.realm(c.realm,c.player);if(this.builds.has(c.realm)&&this.builds.get(c.realm)!==c.build)fail('version');this.builds.set(c.realm,c.build);
      for(const old of this.connections)if(old!==c&&old.authenticated&&old.realm===c.realm&&old.player===c.player)old.ws.close(1008,'replaced');
      c.seat=r.seat;this.store.visit(c.player,'realm',c.realm,String(r.owner),r.name);this.send(c,this.ready(c));this.roster(c.realm);
    }
  }
  clients(id){return [...this.connections].filter(c=>c.kind==='realm'&&c.authenticated&&c.realm===id&&c.ws.readyState===1&&c.seat!==undefined);}
  descriptor(r,player){const id=String(r.id);return {realm:id,name:r.name,owner:String(r.owner),yours:String(r.owner)===player,status:'open',ready:r.setup!==null,created_at_ms:r.created,members:this.store.members(id),inside:this.clients(id).map(c=>({player:c.player,seat:c.seat}))};}
  lobby(c,m){
    if(this.communityLink.lobby(c,m))return;
    if(this.role==='inverna'&&(m.t.startsWith('realm.')||m.t.startsWith('party.world.')))fail('world_server_required');
    if(this.role==='world'&&m.t.startsWith('city.'))fail('inverna_server_required');
    if(m.t==='private.worlds.list'){this.send(c,{t:'private.worlds',worlds:this.store.joinedWorlds(c.player)});return;}
    if(m.t==='private.discord.invite'){this.send(c,{t:'private.discord.invite',invite:this.discordInvites.create(c.player)});return;}
    if(this.friendCodes.handle(c,m))return;
    if(this.trainerArt.handle(c,m))return;
    if(m.t==='plugin.call'){this.plugins.call(c,m).then(data=>this.send(c,{t:'plugin.result',plugin:m.plugin,op:m.op,data})).catch(e=>this.send(c,{t:'err',code:['plugin_busy','plugin_unavailable','plugin_timeout'].includes(e.message)?e.message:'plugin_failed'}));return;}
    if(m.t==='auth.renew'){this.send(c,renewLobby(this,c,m));return;}
    if(this.relay.lobby(c,m))return;
    if(this.mail.handle(c,m))return;
    if(this.chat.handle(c,m))return;
    if(this.friends.handle(c,m))return;
    if(this.social.handle(c,m))return;
    if(m.t==='trainer.get'){this.send(c,{t:'trainer',trainer:this.store.trainer(c.player),applied:false});return;}
    if(m.t==='trainer.put'){
      const before=this.store.trainer(c.player),result=this.store.putTrainer(c.player,m);this.send(c,result);
      if(result.applied&&['name','look','outfit'].some(key=>before?.[key]!==result.trainer[key]))this.social.profileChanged(c.player);
      return;
    }
    if(m.t==='ping'){this.send(c,{t:'pong',ts:integer(m.ts,0,Number.MAX_SAFE_INTEGER),server_ms:Date.now()});return;}
    if(m.t==='realm.list'){const rs=this.store.list(c.player);this.send(c,{t:'realm.list',tier:null,limit:16,can_create:rs.filter(r=>String(r.owner)===c.player).length<16,realms:rs.map(r=>this.descriptor(r,c.player))});return;}
    if(m.t==='realm.create'){const r=this.store.create(c.player,m.name);this.send(c,{t:'realm',realm:this.descriptor(r,c.player)});return;}
    if(m.t==='realm.invite'){text(m.player,20);this.store.invite(m.realm,c.player,m.player);this.send(c,{t:'realm',realm:this.descriptor(this.store.realm(m.realm,c.player),c.player)});return;}
    if(m.t==='realm.enter'){
      this.store.realm(m.realm,c.player);if(this.tickets.size>=4096)fail('busy');const t=randomBytes(32).toString('base64'),h=ticketHash(t);this.tickets.set(h,{hash:h,realm:m.realm,player:c.player,expires:Date.now()+60000});
      this.send(c,{t:'realm.ticket',realm:m.realm,ticket:t,realm_url:this.url.replace(/^http/,'ws')+'/realm',mode:'play'});return;
    }
    fail('unsupported_message');
  }
  ready(c){const r=this.store.realm(c.realm,c.player);return {t:'ready',pt:1,realm:c.realm,name:r.name,mode:'play',seat:r.seat,owner_seat:this.store.members(c.realm).find(m=>m.player===String(r.owner)).seat,members:this.store.members(c.realm),roster:this.clients(c.realm).map(x=>({player:x.player,seat:x.seat})),setup:r.setup,story:{rev:r.story_rev,values:JSON.parse(r.story)},rival:r.rival,member:r.bytes?{rev:r.revision,bytes:r.bytes}:null,save:this.store.latest(c.realm),cap:{fewest:0,members:4},limits:LIMITS,server_ms:Date.now()};}
  broadcast(id,m){for(const c of this.clients(id))this.send(c,m);}
  roster(id){this.broadcast(id,{t:'roster',seats:this.clients(id).map(c=>({player:c.player,seat:c.seat}))});}
  realm(c,m){
    this.store.realm(c.realm,c.player);
    if(m.t==='ping'){this.send(c,{t:'pong',ts:integer(m.ts,0,Number.MAX_SAFE_INTEGER),server_ms:Date.now()});return;}
    if(m.t==='world.publish'){const r=this.store.publish(c.realm,c.player,m.setup,m.story,m.rival);this.broadcast(c.realm,{t:'world',setup:r.setup,story:{rev:r.story_rev,values:JSON.parse(r.story)},rival:r.rival});return;}
    if(m.t==='save.begin'){
      uuid(m.op);integer(m.counter,0,0xffffffff);integer(m.size,1,1048576);hash(m.hash);
      if(this.transfers.has(c.realm))fail('save_busy');const last=this.store.latest(c.realm);if(m.counter!==(last?last.counter+1:1))fail('save_conflict');
      this.transfers.set(c.realm,{connection:c.id,op:m.op,counter:m.counter,size:m.size,hash:m.hash,chunks:[],received:0,expires:Date.now()+60000});this.send(c,{t:'save.go',op:m.op,chunk:4096});return;
    }
    if(m.t==='save.chunk'){
      const t=this.transfers.get(c.realm);if(!t||t.connection!==c.id||t.op!==m.op)fail('no_transfer');integer(m.index,0,255);const b=b64(m.data,4096);if(!b.length||m.index!==t.chunks.length||t.received+b.length>t.size)fail('bad_chunk');t.chunks.push(b);t.received+=b.length;t.expires=Date.now()+60000;return;
    }
    if(m.t==='save.commit'){
      const t=this.transfers.get(c.realm);if(!t||t.connection!==c.id||t.op!==m.op)fail('no_transfer');if(t.received!==t.size)fail('incomplete_save');
      const saved=this.store.save(c.realm,c.player,t.op,t.counter,t.hash,Buffer.concat(t.chunks));this.transfers.delete(c.realm);this.send(c,{t:'save.ack',op:t.op,counter:saved.counter,hash:saved.hash});this.log('save_committed',{realm:c.realm,counter:saved.counter,size:t.size});this.plugins.emit('world.saved',{realm:c.realm,player:c.player,counter:saved.counter});return;
    }
    // Native download verb is being verified; explicit extensions are not advertised as native support.
    if(m.t==='save.get'){
      const s=this.store.payload(c.realm);if(!s){this.send(c,{t:'save.none'});return;}
      const count=Math.ceil(s.payload.length/4096);for(let i=0;i<count;i++)this.send(c,{t:'save.data',index:i,count,data:s.payload.subarray(i*4096,(i+1)*4096).toString('base64')});
      this.send(c,{t:'save.end',counter:s.counter,hash:s.hash,size:s.payload.length});return;
    }
    if(m.t==='leave'){c.ws.close(1000,'left');return;}
    fail('unsupported_message');
  }
  binary(c,data){
    if(c.authenticated&&c.kind==='lobby'&&c.city){
      const wire=cityFrame(data,c.citySlot);
      for(const peer of this.social.cityPlayers(c.city))if(peer!==c){if(peer.ws.bufferedAmount>2097152)peer.ws.close(1008,'slow consumer');else peer.ws.send(wire,{binary:true});}
      return;
    }
    if(!c.authenticated||c.kind!=='realm'||c.seat===undefined)fail('bad_binary');
    const clients=this.clients(c.realm),{targets,wire}=routeFrame(data,c.seat,clients.map(x=>x.seat));
    for(const target of clients)if(targets.includes(target.seat)){if(target.ws.bufferedAmount>2097152){target.ws.close(1008,'slow consumer');continue;}target.ws.send(wire,{binary:true});}
  }
}
