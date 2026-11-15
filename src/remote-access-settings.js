import {db} from './db.js';
const columns=db.prepare('PRAGMA table_info(tailscale)').all().map(c=>c.name);
for(const [name,sql] of [['provider',"TEXT NOT NULL DEFAULT 'tailscale'"],['login_server',"TEXT NOT NULL DEFAULT ''"]]) if(!columns.includes(name))db.exec(`ALTER TABLE tailscale ADD COLUMN ${name} ${sql}`);
const defaults={provider:'tailscale',loginServer:''};
export function remoteAccessSettings(){const r=db.prepare("SELECT value FROM settings WHERE key='remote-access'").get();return {...defaults,...(r?JSON.parse(r.value):{})};}
export function saveRemoteAccessSettings(input){
  const fail=message=>{throw Object.assign(new Error(message),{statusCode:400});};
  if(!input||Object.keys(input).some(k=>!['provider','loginServer'].includes(k))||!['tailscale','headscale'].includes(input.provider)||typeof input.loginServer!=='string')fail('Choose a remote access provider');
  let loginServer='';
  if(input.provider==='headscale'){
    let u;try{u=new URL(input.loginServer);}catch{fail('Provide the Headscale HTTPS URL');}
    if(/[\s'"`$\\]/.test(input.loginServer)||u.protocol!=='https:'||u.username||u.password||u.search||u.hash||input.loginServer.length>500)fail('Use a Headscale HTTPS URL without credentials, query parameters or fragments');
    loginServer=u.href.replace(/\/$/,'');
  }
  const value={provider:input.provider,loginServer};
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('remote-access',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(value));
  return value;
}
