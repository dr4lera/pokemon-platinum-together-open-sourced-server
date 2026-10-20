import {fail} from './identity.mjs';
import {randomUUID} from 'node:crypto';
import {integer,text} from './store.mjs';

export class Chat {
  constructor(hub){this.hub=hub;this.db=hub.store.db;}
  channel(value){if(typeof value!=='string'||!(/^(global|lang\.[a-z]{2,3}(?:-[a-z]{2})?)$/.test(value)))fail('unsupported_channel');return value;}
  wire(row){if(row.plugin)return {id:row.id,at_ms:row.at_ms,kind:'system',role:'system',from:'Server',name:'Plugin',text:row.body,op:row.op};return {id:row.id,at_ms:row.at_ms,kind:'say',role:'member',from:this.hub.store.playerInfo(String(row.player)).name,name:this.hub.store.trainer(String(row.player))?.name??this.hub.store.playerInfo(String(row.player)).name,text:row.body,op:row.op};}
  history(c,channel,before=Number.MAX_SAFE_INTEGER,limit=30){
    integer(before,1,Number.MAX_SAFE_INTEGER);integer(limit,1,50);
    const rows=this.db.prepare('SELECT * FROM chat_messages WHERE channel=? AND id<? AND (recipient IS NULL OR recipient=?) ORDER BY id DESC LIMIT ?').all(channel,before,c.player,limit+1);
    const more=rows.length>limit;const read=this.db.prepare('SELECT upto FROM chat_reads WHERE player=? AND channel=?').get(c.player,channel)?.upto??0;
    this.hub.send(c,{t:'chat',channel,msgs:rows.slice(0,limit).reverse().map(r=>this.wire(r)),more,read_upto:read});
  }
  reply(c,channel,op,plugin,reply){
    this.hub.store.player(c.player);text(reply,400);
    const body=`[${plugin}] ${reply}`,r=this.db.prepare('INSERT INTO chat_messages(channel,player,body,op,at_ms,plugin,recipient,reply_to) VALUES(?,?,?,?,?,?,?,?)').run(channel,c.player,body,randomUUID(),Date.now(),plugin,c.player,op);
    const row=this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(r.lastInsertRowid);this.hub.send(c,{t:'chat.new',channel,msg:this.wire(row)});
  }
  handle(c,m){
    if(!['chat.get','chat.join','chat.leave','chat.send','chat.read'].includes(m.t))return false;
    const channel=this.channel(m.channel);c.channels??=new Set();
    if(m.t==='chat.get'){this.history(c,channel,m.before===0?Number.MAX_SAFE_INTEGER:m.before??Number.MAX_SAFE_INTEGER,m.limit??30);return true;}
    if(m.t==='chat.join'){if(c.channels.size>=8&&!c.channels.has(channel))fail('too_many_channels');c.channels.add(channel);this.history(c,channel);return true;}
    if(m.t==='chat.leave'){c.channels.delete(channel);return true;}
    if(m.t==='chat.read'){
      integer(m.upto,0,Number.MAX_SAFE_INTEGER);const max=this.db.prepare('SELECT MAX(id) AS n FROM chat_messages WHERE channel=? AND (recipient IS NULL OR recipient=?)').get(channel,c.player).n??0;if(m.upto>max)fail('bad_read');
      this.db.prepare('INSERT INTO chat_reads(player,channel,upto) VALUES(?,?,?) ON CONFLICT(player,channel) DO UPDATE SET upto=max(upto,excluded.upto)').run(c.player,channel,m.upto);this.history(c,channel);return true;
    }
    if(typeof m.op!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.op))fail('bad_op');text(m.text,480);
    const old=this.db.prepare('SELECT * FROM chat_messages WHERE player=? AND op=?').get(c.player,m.op);
    if(old){if(old.channel!==channel||old.body!==m.text)fail('op_conflict');this.hub.send(c,{t:'chat.new',channel,msg:this.wire(old)});for(const reply of this.db.prepare('SELECT * FROM chat_messages WHERE reply_to=? AND recipient=? ORDER BY id').all(m.op,c.player))this.hub.send(c,{t:'chat.new',channel,msg:this.wire(reply)});return true;}
    if(!c.channels.has(channel))fail('join_channel_first');const last=this.db.prepare('SELECT MAX(at_ms) AS n FROM chat_messages WHERE player=?').get(c.player).n??0;if(Date.now()-last<750)fail('chat_rate_limit');
    const match=/^\/([a-z][a-z0-9-]{0,47})(?:\s+(.*))?$/s.exec(m.text),plugin=match&&this.hub.plugins.loaded.get(match[1]);
    const command=plugin?.state==='running';
    const r=this.db.prepare('INSERT INTO chat_messages(channel,player,body,op,at_ms,recipient) VALUES(?,?,?,?,?,?)').run(channel,c.player,m.text,m.op,Date.now(),command?c.player:null);const row=this.db.prepare('SELECT * FROM chat_messages WHERE id=?').get(r.lastInsertRowid);
    const response={t:'chat.new',channel,msg:this.wire(row)};
    if(command){
      this.hub.send(c,response);
      this.hub.plugins.request(plugin,{type:'command',op:m.op,data:{player:c.player,username:this.hub.store.playerInfo(c.player).name,channel,args:match[2]??''}})
       .then(result=>{if(result?.reply!==undefined)this.reply(c,channel,m.op,plugin.id,result.reply);})
       .catch(()=>{try{this.reply(c,channel,m.op,plugin.id,'That command is unavailable.');}catch{}});
    }else{
      this.hub.plugins.emit('chat.message',{player:c.player,username:this.hub.store.playerInfo(c.player).name,channel,text:m.text,op:m.op});
      for(const peer of this.hub.connections)if(peer.authenticated&&peer.kind==='lobby'&&peer.channels?.has(channel))this.hub.send(peer,response);
    }
    return true;
  }
}
