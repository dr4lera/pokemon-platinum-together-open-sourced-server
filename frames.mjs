import {fail} from './identity.mjs';
// Native serializer RVA 0x882672 and decoder 0x882725, version 0.1.5.
// Byte 1 addresses a destination from the client and identifies the sender from the server.
export function routeFrame(frame,source,available){
  if(!Buffer.isBuffer(frame)||frame.length<2||frame.length>8194||frame[0]!==1||!(frame[1]<=3||frame[1]===255)||source<0||source>3)fail('bad_game_frame');
  const destination=frame[1],targets=available.filter(seat=>seat!==source&&(destination===255||seat===destination));
  const wire=Buffer.from(frame);wire[1]=source;return {targets,wire};
}

// Native city encoder 0x87db34 emits [2, claimed-slot, length, payload].
// Native decoder 0x87dc2d reads [2, count, {slot,length,payload}...].
// The server supplies the authenticated slot; clients cannot impersonate peers.
export function cityFrame(frame,slot){
  if(!Buffer.isBuffer(frame)||frame.length<4||frame[0]!==2||frame[2]<1||frame[2]>32||frame.length!==frame[2]+3||!Number.isInteger(slot)||slot<0||slot>63)fail('bad_city_frame');
  return Buffer.concat([Buffer.from([2,1,slot,frame[2]]),frame.subarray(3)]);
}
