import {parentPort,workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
const plugin=await import(pathToFileURL(workerData.entry));
if(typeof plugin.onEvent!=='function')throw new Error('Missing onEvent export');
parentPort.on('message',async m=>{
 try{
  const result=await plugin.onEvent(m.event,Object.freeze({dataDirectory:workerData.dataDirectory}));
  const json=JSON.stringify(result??null);
  if(Buffer.byteLength(json)>8192)throw new Error('Plugin result too large');
  parentPort.postMessage({id:m.id,result:JSON.parse(json)});
 }catch{parentPort.postMessage({id:m.id,error:'plugin_failed'});}
});
parentPort.postMessage({ready:true});
