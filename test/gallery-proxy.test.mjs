import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {startGalleryProxy} from '../gallery-proxy.mjs';

test('native gallery adapter pins the server, limits routes, and verifies content hashes',async()=>{
 const pin=Buffer.alloc(32,4).toString('base64'),pack=Buffer.from('original disposable content'),hash=createHash('sha256').update(pack).digest('hex');let changed=false,badPack=false;
 const server=createServer((req,res)=>{
  if(req.url==='/private/server-info')res.end(JSON.stringify({hub_key:changed?'other':pin}));
  else if(req.url==='/api/creators/v1/game/players/1/trainers')res.end(JSON.stringify({t:'collection',revision:1,synced_ms:1,items:[],next:null}));
  else if(req.url==='/api/creators/v1/packs/'+hash+'.pttrainer')res.end(badPack?'corrupt':pack);
  else {res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let proxy;
 try{
  const origin='http://127.0.0.1:'+server.address().port;
  await assert.rejects(()=>startGalleryProxy({origin,pin:'wrong',player:'1'}));
  proxy=await startGalleryProxy({origin,pin,player:'1'});
  assert.equal((await fetch(proxy.url+'/api/creators/v1/game/players/1/trainers').then(r=>r.json())).t,'collection');
  assert.equal((await fetch(proxy.url+'/api/creators/v1/game/players/2/trainers')).status,404);
  assert.equal((await fetch(proxy.url+'/auth/account')).status,404);
  assert.deepEqual(Buffer.from(await fetch(proxy.url+'/api/creators/v1/packs/'+hash+'.pttrainer').then(r=>r.arrayBuffer())),pack);
  badPack=true;assert.equal((await fetch(proxy.url+'/api/creators/v1/packs/'+hash+'.pttrainer')).status,502);
  changed=true;assert.equal((await fetch(proxy.url+'/api/creators/v1/game/players/1/trainers')).status,502);
 }finally{if(proxy)await proxy.close();await new Promise(resolve=>server.close(resolve));}
});
