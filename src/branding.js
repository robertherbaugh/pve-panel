import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { imageSize } from 'image-size';
import { db } from './db.js';
import { config } from './config.js';

export const MAX_BRANDING_BYTES = 1024 * 1024;
export const BRANDING_SLOTS = ['logo', 'os-windows', 'os-linux'];
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const KEY = 'branding';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
db.exec(`CREATE TABLE IF NOT EXISTS branding_assets (
  slot TEXT PRIMARY KEY CHECK(slot IN ('logo','os-windows','os-linux')),
  content_type TEXT NOT NULL, data BLOB NOT NULL, sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

function validateImage(bytes, type) {
  if (!TYPES[type]) throw fail('Use a PNG, JPEG, WebP or SVG image');
  if (!bytes.length || bytes.length > MAX_BRANDING_BYTES) throw fail('Images must be between 1 byte and 1 MiB');
  if (type === 'image/svg+xml') {
    let root = null;
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { throw fail('SVG document types and entities are not supported'); });
    parser.on('processinginstruction', () => { throw fail('SVG processing instructions are not supported'); });
    parser.on('opentag', (node) => {
      root ??= node;
      if (/^(script|foreignObject|iframe|object|embed|audio|video)$/i.test(node.local))
        throw fail('Use an SVG without scripts or embedded documents');
      for (const attr of Object.values(node.attributes)) {
        if (/^on/i.test(attr.local)) throw fail('SVG event handlers are not supported');
        if (attr.local === 'href' && !/^(#|data:image\/(png|jpeg|webp);base64,)/i.test(attr.value))
          throw fail('SVG images must not link to external resources');
      }
    });
    try {
      parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close();
    } catch (err) {
      throw err.statusCode ? err : fail('The SVG image is not valid XML');
    }
    if (root?.local !== 'svg' || root.uri !== 'http://www.w3.org/2000/svg')
      throw fail('Use an SVG image with an SVG root and namespace');
  } else {
    let size;
    try { size = imageSize(bytes); } catch { throw fail('The image data is not valid'); }
    if (size.type !== TYPES[type] || !size.width || !size.height)
      throw fail('The image content does not match its file type');
    if (size.width > 8192 || size.height > 8192 || size.width * size.height > 16_777_216)
      throw fail('Images must be no larger than 8192 pixels per side and 16 megapixels');
  }
}
function storeAsset(slot, type, bytes) {
  db.prepare(`INSERT INTO branding_assets(slot,content_type,data,sha256) VALUES(?,?,?,?)
    ON CONFLICT(slot) DO UPDATE SET content_type=excluded.content_type,data=excluded.data,
    sha256=excluded.sha256,updated_at=datetime('now')`).run(slot, type, bytes, digest(bytes));
}

// Import the old settings once. Subsequent starts read only the database.
export function initializeBranding(log) {
  if (db.prepare('SELECT 1 FROM settings WHERE key=?').get(KEY)) return;
  const directory = path.resolve(config.brand.dir || path.join(path.dirname(path.resolve(config.dbPath)), 'branding'));
  const imported = [];
  for (const slot of BRANDING_SLOTS) {
    for (const [type, extension] of Object.entries(TYPES).sort((a, b) => a[1].localeCompare(b[1]))) {
      const file = path.join(directory, `${slot}.${extension}`);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_BRANDING_BYTES) throw fail('The legacy image does not meet the upload limits');
        const bytes = fs.readFileSync(file);
        validateImage(bytes, type);
        imported.push({ slot, type, bytes });
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') log?.warn(`Could not import the legacy ${slot} branding image. Upload it through Settings.`);
      }
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const asset of imported) storeAsset(asset.slot, asset.type, asset.bytes);
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(KEY, JSON.stringify({ name: config.brand.name || 'PVE Panel' }));
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}
export function brandingName() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(KEY);
  return row ? JSON.parse(row.value).name : (config.brand.name || 'PVE Panel');
}
export function brandingSettings() {
  const assets = Object.fromEntries(db.prepare('SELECT slot,content_type,sha256,length(data) AS bytes FROM branding_assets ORDER BY slot').all().map((a) => [a.slot, {
    type: a.content_type, bytes: a.bytes,
    url: `/branding/${a.slot}.${TYPES[a.content_type]}?v=${a.sha256}`,
  }]));
  const state = { name: brandingName(), assets };
  return { ...state, revision: `"${digest(JSON.stringify(state))}"` };
}
export function publicBranding() {
  const state = brandingSettings();
  return { name: state.name, logo: state.assets.logo?.url ?? null,
    osIcons: Object.fromEntries(['windows', 'linux'].filter((os) => state.assets[`os-${os}`]).map((os) => [os, state.assets[`os-${os}`].url])) };
}
function checkRevision(revision) {
  if (!revision) throw fail('Reload branding settings before saving', 428);
  if (revision !== brandingSettings().revision) throw fail('Branding changed in another session. Reload before saving.', 409);
}
export function saveBrandingName(name, revision) {
  checkRevision(revision);
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(name))
    throw fail('Use a panel name of 1–40 characters without control characters');
  db.prepare("UPDATE settings SET value=?,updated_at=datetime('now') WHERE key=?").run(JSON.stringify({ name: name.trim() }), KEY);
  return brandingSettings();
}
export function saveBrandingAsset(slot, input, revision) {
  checkRevision(revision);
  if (!BRANDING_SLOTS.includes(slot)) throw fail('Unknown branding image', 404);
  if (!input || !TYPES[input.type] || typeof input.data !== 'string' || (input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)))
    throw fail('Use a supported image encoded as base64');
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.toString('base64') !== input.data) throw fail('The base64 image data is not valid');
  validateImage(bytes, input.type);
  storeAsset(slot, input.type, bytes);
  return brandingSettings();
}
export function removeBrandingAsset(slot, revision) {
  checkRevision(revision);
  if (!BRANDING_SLOTS.includes(slot)) throw fail('Unknown branding image', 404);
  db.prepare('DELETE FROM branding_assets WHERE slot=?').run(slot);
  return brandingSettings();
}
export async function brandingFiles(app) {
  app.get('/branding/:file', async (req, reply) => {
    const match = /^(logo|os-windows|os-linux)\.(svg|png|webp|jpg)$/.exec(req.params.file);
    const asset = match && db.prepare('SELECT * FROM branding_assets WHERE slot=?').get(match[1]);
    if (!asset || TYPES[asset.content_type] !== match[2] || (req.query.v && req.query.v !== asset.sha256))
      return reply.code(404).send({ error: 'Branding image not found' });
    reply.header('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-store');
    reply.header('ETag', `"${asset.sha256}"`);
    if (req.headers['if-none-match'] === `"${asset.sha256}"`) return reply.code(304).send();
    return reply.type(asset.content_type).send(Buffer.from(asset.data));
  });
}
