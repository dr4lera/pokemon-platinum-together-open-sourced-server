import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export function fail(code) { throw Object.assign(new Error(code), {code}); }
export function b64(value, max, exact) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('bad_base64');
  const b = Buffer.from(value, 'base64');
  if (b.length > max || (exact !== undefined && b.length !== exact) || b.toString('base64') !== value) fail('bad_base64');
  return b;
}
export const sha = b => createHash('sha256').update(b).digest();
export function rawPublic(key) {return key.export({type:'spki',format:'der'}).subarray(-32);}
export function publicKey(raw) {return createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), raw]),type:'spki',format:'der'});}
export function privateKey(seed) {return createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), seed]),type:'pkcs8',format:'der'});}
export function loadIdentity(dir) {
  const path = join(dir, 'server-key.pem');
  if (!existsSync(path)) {
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(path, pair.privateKey.export({type:'pkcs8',format:'pem'}), {flag:'wx',mode:0o600});
  }
  const key = createPrivateKey(readFileSync(path));
  return {key, public:createPublicKey(key), pin:rawPublic(createPublicKey(key)).toString('base64')};
}

// Native PT account token: 58 bytes, Ed25519 signature, base64 JSON envelope.
export function issueToken(identity, player, key, now=Date.now()) {
  const bytes=Buffer.alloc(58); bytes[0]=1; bytes[1]=1;
  bytes.writeBigUInt64LE(BigInt(player),2); b64(key,32,32).copy(bytes,10);
  bytes.writeBigUInt64LE(BigInt(now),42); bytes.writeBigUInt64LE(BigInt(now+3_600_000),50);
  const packed=Buffer.from(JSON.stringify({bytes:bytes.toString('base64'),sig:sign(null,bytes,identity.key).toString('base64')})).toString('base64');
  return {token:packed,player_id:player,expires_at_ms:now+3_600_000};
}
export function readToken(identity, packed, now=Date.now()) {
  if (typeof packed!=='string' || packed.length>4096) fail('bad_token');
  try {
    const obj=JSON.parse(b64(packed,3072).toString());const bytes=b64(obj.bytes,58,58);
    if (bytes[0]!==1 || bytes[1]!==1 || !verify(null,bytes,identity.public,b64(obj.sig,64,64))) fail('bad_token');
    const player=bytes.readBigUInt64LE(2).toString(),issued=Number(bytes.readBigUInt64LE(42)),expires=Number(bytes.readBigUInt64LE(50));
    if (!Number.isSafeInteger(issued)||!Number.isSafeInteger(expires)||issued>now+5000||issued>expires||expires-issued>3_600_000||expires<=now) fail('auth_expired');
    return {player, key:bytes.subarray(10,42), bytes, expires};
  } catch(e) {fail(e.code==='auth_expired'?'auth_expired':'bad_token');}
}
export function proofBytes(domain, nonce, tail) { return Buffer.concat([Buffer.from(domain+'\0','ascii'),nonce,tail]); }
export function checkProof(key, domain, nonce, tail, sig) {
  if (!verify(null,proofBytes(domain,nonce,tail),publicKey(key),b64(sig,64,64))) fail('bad_proof');
}
export function newClient() {
  const pair=generateKeyPairSync('ed25519');
  return {seed:pair.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('base64'),key:rawPublic(pair.publicKey).toString('base64')};
}
export const secret = () => randomBytes(32).toString('base64url');
