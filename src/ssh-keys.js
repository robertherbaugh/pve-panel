import { createHash, randomUUID } from 'node:crypto';
import { db, audit } from './db.js';
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
db.exec(`CREATE TABLE IF NOT EXISTS user_ssh_keys (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(user_id,fingerprint)
)`);
export function parsePublicKey(value) {
  if (typeof value !== 'string' || value.length > 16000 || /[\r\n]/.test(value.trim())) fail('Provide one OpenSSH public key.');
  const [type, encoded] = value.trim().split(/\s+/);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('Invalid SSH public key.');
  const blob = Buffer.from(encoded, 'base64'); let at = 0;
  const field = () => {
    if (at + 4 > blob.length) fail('Invalid SSH public key.');
    const n = blob.readUInt32BE(at); at += 4;
    if (n > blob.length - at) fail('Invalid SSH public key.');
    const v = blob.subarray(at, at+n); at += n; return v;
  };
  if (field().toString() !== type) fail('The SSH key type does not match its contents.');
  if (type === 'ssh-ed25519' || type === 'sk-ssh-ed25519@openssh.com') {
    if (field().length !== 32) fail('Invalid Ed25519 key.');
    if (type.startsWith('sk-') && !field().length) fail('Invalid security key application.');
  } else if (type === 'ssh-rsa') {
    if (!field().length) fail('Invalid RSA exponent.');
    const modulus = field(); const n = modulus[0] === 0 ? modulus.subarray(1) : modulus;
    const bits = n.length ? (n.length - 1) * 8 + 32 - Math.clz32(n[0]) : 0;
    if (bits < 2048 || bits > 16384) fail('Use an RSA key from 2048 to 16384 bits.');
  } else if (/^(?:ecdsa-sha2-nistp(?:256|384|521)|sk-ecdsa-sha2-nistp256@openssh.com)$/.test(type)) {
    const curve = field().toString(), point = field(), lengths = { nistp256: 65, nistp384: 97, nistp521: 133 };
    if (!type.includes(curve) || point.length !== lengths[curve] || point[0] !== 4) fail('Invalid ECDSA key.');
    if (type.startsWith('sk-') && !field().length) fail('Invalid security key application.');
  } else fail('Use an Ed25519, RSA, ECDSA or OpenSSH security public key.');
  if (at !== blob.length || blob.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) fail('Invalid SSH public key encoding.');
  return { publicKey: `${type} ${blob.toString('base64')}`, fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` };
}
export const savedSshKeys = userId => db.prepare('SELECT id,name,public_key AS publicKey,fingerprint,created_at AS createdAt FROM user_ssh_keys WHERE user_id=? ORDER BY created_at,id').all(userId);
export function resolveSshKeys(userId, spec) {
  if (!spec.sshKeyIds?.length) return;
  const keys = savedSshKeys(userId), selected = spec.sshKeyIds.map(id => keys.find(k => k.id === id));
  if (selected.some(k => !k)) fail('A selected SSH key is unavailable for your account.');
  spec.sshKeys = [spec.sshKeys?.trim(), ...selected.map(k => k.publicKey)].filter(Boolean).join('\n');
  if (spec.sshKeys.length > 16000) fail('The selected SSH keys exceed the allowed size.');
}
export default async function sshKeyRoutes(app) {
  app.addHook('preHandler', app.authenticate);
  app.get('/api/ssh-keys', async req => ({ keys: savedSshKeys(req.account.id) }));
  app.post('/api/ssh-keys', { schema: { body: { type:'object', additionalProperties:false, required:['name','publicKey'], properties:{name:{type:'string',minLength:1,maxLength:80},publicKey:{type:'string',minLength:20,maxLength:16000}} } } }, async (req, reply) => {
    const name = req.body.name.trim(), key = parsePublicKey(req.body.publicKey);
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) fail('Choose an SSH key name.');
    const keys = savedSshKeys(req.account.id);
    if (keys.length >= 20) fail('Save at most 20 SSH keys.');
    if (keys.some(k => k.fingerprint === key.fingerprint)) fail('This SSH key is already saved.',409);
    const id = randomUUID();
    db.prepare('INSERT INTO user_ssh_keys(id,user_id,name,public_key,fingerprint) VALUES(?,?,?,?,?)').run(id,req.account.id,name,key.publicKey,key.fingerprint);
    audit(req,null,'ssh_key_saved',{id,fingerprint:key.fingerprint});
    return reply.code(201).send(savedSshKeys(req.account.id).find(k=>k.id===id));
  });
  app.delete('/api/ssh-keys/:id', async (req, reply) => {
    const result = db.prepare('DELETE FROM user_ssh_keys WHERE id=? AND user_id=?').run(req.params.id, req.account.id);
    if (!result.changes) fail('SSH key not found.',404);
    audit(req,null,'ssh_key_removed',{id:req.params.id});
    return reply.code(204).send();
  });
}
