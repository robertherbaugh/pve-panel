// Provisioned network access is independent of browser sessions. Only a signed
// SSO login can update this identity snapshot. Current local policy, membership
// blocks, user status and VM boundaries are still evaluated on each reconcile.
import { db } from "./db.js";
import { config } from "./config.js";

const provisioned = new WeakSet();
export function initializeNetworkAuthorization(user, identity) {
  // Upgrade a still-valid browser authorization from an older panel release.
  // Never replace a newer signed-login snapshot with an older open session.
  if (
    !db
      .prepare("SELECT 1 FROM network_authorizations WHERE user_id=?")
      .get(user.id)
  )
    rememberNetworkAuthorization(user, identity);
}
export function rememberNetworkAuthorization(user, identity) {
  db.prepare(
    `INSERT INTO network_authorizations(user_id,issuer,subject,claims,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET issuer=excluded.issuer,
    subject=excluded.subject,claims=excluded.claims,updated_at=excluded.updated_at`,
  ).run(
    user.id,
    user.oidc_issuer,
    user.oidc_subject,
    JSON.stringify(identity),
    Math.floor(Date.now() / 1000),
  );
}
export function networkRequest(userId, customerId) {
  const req = { account: { id: userId }, selectedCustomerId: customerId };
  provisioned.add(req);
  return req;
}
export function networkAuthorizationFor(req) {
  if (!provisioned.has(req)) return null;
  const row = db
    .prepare(
      `SELECT a.* FROM network_authorizations a JOIN users u ON u.id=a.user_id
    WHERE a.user_id=? AND a.issuer=u.oidc_issuer AND a.subject=u.oidc_subject
    AND u.disabled=0 AND u.deleting=0`,
    )
    .get(req.account.id);
  if (!row || row.issuer !== config.oidc.issuer) return null;
  const claims = JSON.parse(row.claims);
  if (config.oidc.requireVerifiedEmail && !claims.emailVerified) return null;
  return { ...claims, expiresAt: null };
}
