import { db } from './db.js';
const fail=(message,statusCode=400)=>{throw Object.assign(new Error(message),{statusCode});};
const defaults={enabled:false,nodes:[],slaVersion:'',msaVersion:'',terms:'',infrastructureVerified:false};
db.exec(`CREATE TABLE IF NOT EXISTS compute_ha_policy (revision INTEGER PRIMARY KEY,value TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
export function haPolicy() {
  const row=db.prepare('SELECT * FROM compute_ha_policy ORDER BY revision DESC LIMIT 1').get();
  return {...defaults,...(row?JSON.parse(row.value):{}),revision:row?.revision??0};
}
export function saveHaPolicy(input) {
  if(!input || Object.keys(input).some(k=>!['revision',...Object.keys(defaults)].includes(k))) fail('Invalid HA policy');
  if(!Number.isSafeInteger(input.revision)||typeof input.enabled!=='boolean'||typeof input.infrastructureVerified!=='boolean') fail('Invalid HA policy controls');
  if(!Array.isArray(input.nodes)||input.nodes.length>64||new Set(input.nodes).size!==input.nodes.length||input.nodes.some(n=>typeof n!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(n))) fail('Choose valid HA node IDs');
  for(const k of ['slaVersion','msaVersion','terms']) if(typeof input[k]!=='string'||input[k].length>(k==='terms'?12000:100)||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(input[k])) fail('Invalid HA agreement text');
  if(input.enabled && (input.nodes.length<3 || !input.infrastructureVerified || !input.slaVersion.trim() || !input.msaVersion.trim() || !input.terms.trim())) fail('HA needs at least three verified nodes and published SLA/MSA versions and terms');
  const current=haPolicy();
  if(current.revision!==input.revision) fail('HA policy changed. Reload before saving.',409);
  const value=Object.fromEntries(Object.keys(defaults).map(k=>[k,input[k]]));
  const retained=db.prepare("SELECT 1 FROM compute_ha_reservations WHERE state!='released' LIMIT 1").get();
  if(retained && ['nodes','slaVersion','msaVersion','terms','infrastructureVerified'].some(k=>JSON.stringify(value[k])!==JSON.stringify(current[k]))) fail('Disable HA on the affected VMs before changing its infrastructure or agreements',409);
  db.prepare('INSERT INTO compute_ha_policy(revision,value) VALUES(?,?)').run(current.revision+1,JSON.stringify(value));
  return haPolicy();
}
