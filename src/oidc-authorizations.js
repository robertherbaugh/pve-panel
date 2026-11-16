import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { rememberNetworkAuthorization, networkAuthorizationFor } from './network-authorizations.js';
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const strings = (value, name) => {
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some((v) => typeof v !== 'string' || !v || v.length > 200)
  )
    throw fail(`Invalid ${name}`);
  return [...new Set(value)];
};

/** Only call with claims returned by openid-client's validated code exchange. */
export function rememberAuthorization(user, claims) {
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== config.oidc.issuer ||
    claims.sub !== user.oidc_subject ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= now
  ) {
    throw fail('Invalid OIDC authorization identity');
  }
  if (config.oidc.requireVerifiedEmail && claims.email_verified !== true)
    throw fail('OIDC email must be verified');
  const identity = {
    groups: strings(claims[config.oidc.groupsClaim] ?? [], 'OIDC groups'),
    entitlements: strings(claims[config.oidc.entitlementsClaim] ?? [], 'OIDC entitlements'),
    emailVerified: claims.email_verified === true,
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '',
  };
  const id = crypto.randomBytes(24).toString('base64url');
  const expires = Math.min(claims.exp, now + config.oidc.authorizationMaxAge);
  db.prepare('DELETE FROM oidc_authorizations WHERE expires_at < ?').run(now - 86400);
  db.prepare(
    `INSERT INTO oidc_authorizations (id,user_id,issuer,subject,claims,expires_at)
    VALUES (?,?,?,?,?,?)`,
  ).run(id, user.id, claims.iss, claims.sub, JSON.stringify(identity), expires);
  rememberNetworkAuthorization(user, identity);
  return id;
}
export function authorizationFor(req) {
  const network = networkAuthorizationFor(req);
  if (network) return network;
  if (!req.user?.az) return null;
  const row = db
    .prepare(
      `SELECT a.* FROM oidc_authorizations a JOIN users u ON u.id=a.user_id
    WHERE a.id=? AND a.user_id=? AND a.issuer=u.oidc_issuer AND a.subject=u.oidc_subject AND u.disabled=0 AND u.deleting=0`,
    )
    .get(req.user.az, req.account.id);
  if (!row || row.issuer !== config.oidc.issuer || row.expires_at <= Date.now() / 1000) return null;
  const identity = JSON.parse(row.claims);
  if (config.oidc.requireVerifiedEmail && identity.emailVerified !== true) return null;
  return { ...identity, expiresAt: row.expires_at };
}
export function forgetAuthorization(req) {
  if (req.user?.az)
    db.prepare('DELETE FROM oidc_authorizations WHERE id=? AND user_id=?').run(req.user.az, req.account.id);
}
