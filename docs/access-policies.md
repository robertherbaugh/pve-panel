# OIDC access policies (fork extension)

This fork of PVE Panel 1.16.0 adds shared VM access and controlled creation from
OIDC groups and application entitlements. The released upstream uses individual
VM ownership. Policies start **disabled**. Configure them in **Admin → Permissions**.
Users authenticate to the panel; the panel uses its Proxmox service account.
Individual Proxmox accounts and live Proxmox group lookups are unnecessary.

## Identity and resource matching

The panel reads string arrays from the validated **ID token**, by default:

```json
{
  "email": "engineer@example.com",
  "email_verified": true,
  "groups": ["implementation-engineers"],
  "entitlements": ["production:operate"]
}
```

Set `OIDC_GROUPS_CLAIM` / `OIDC_ENTITLEMENTS_CLAIM` for different top-level claim
names. Only the configured issuer's signed Authorization Code + PKCE exchange
can establish these grants; customer request bodies cannot supply claims.

A policy needs an exact email domain and at least one matching group or
entitlement. Each rule can require either list (**any**) or a match from each
nonempty list (**all**). Within one list any named value suffices. A domain alone
gives no access. Rule grants are additive; there are no deny rules.

A guest must belong to an exact configured **Proxmox resource pool**, have every
required tag, and match the optional VM-ID list. Pools, tags and panel display
labels are distinct. There are no wildcard or prefix matches. Templates and the
configured VPN gateway are excluded from shared grants. Only trusted operators
should control pool membership, access tags, templates and saved snapshots.
Snapshot rollback restores saved configuration as well as guest state; review
snapshots when changing a guest's security classification.

Pool-scoped `Administrator` in Proxmox does not create a panel administrator.
The panel's existing administrator flag remains separate. The policy does not
import or continuously synchronize Proxmox ACLs.

## Authentik

For Authentik 2026.8, the built-in `profile` mapping emits the `groups` claim.
There is no need to request a literal `groups` scope unless you create a custom
scope mapping. Add the built-in **entitlements** scope mapping to this panel's
OAuth2 provider and request:

```dotenv
OIDC_SCOPES=openid email profile entitlements
OIDC_GROUPS_CLAIM=groups
OIDC_ENTITLEMENTS_CLAIM=entitlements
OIDC_AUTHORIZATION_MAX_AGE_SECONDS=300
```

Authentik's entitlements scope emits the names of the signed-in user's
application entitlements. Create them on the PVE Panel application and bind
users/groups. Application entitlements are independent from global groups.
This extension matches entitlement names and guest attributes; it does not
evaluate arbitrary Authentik entitlement attribute dictionaries or expressions.
Include the claims in ID tokens. Claims present only in a UserInfo response are
not used. Reauthenticate after changing scopes or membership.

Use `PASSWORD_LOGIN_CUSTOMER=false` for OIDC-only customer access. Keep a tested
administrator recovery method. For accounts controlled entirely by these
policies, leave individual creation disabled (`canCreate=false`) and avoid
legacy owner assignments. Those are independent, existing grants. Account
creation/linking still follows `OIDC_AUTO_CREATE`, `OIDC_ALLOWED_DOMAINS` and
`OIDC_REQUIRE_VERIFIED_EMAIL`. Never trust a self-editable email as proof of
an allowed domain. Authentik's built-in email mapping can emit
`email_verified=false`; only relax that requirement for an administrator-managed
identity directory without user-editable addresses or public enrollment.

## Creation and quotas

Each creation rule specifies an exact offered image allowlist, allowed disk
storages, destination pool and positive per-creator limits. A VM image uses its
configured target storage, or all inherited disk storage IDs when no override
is configured. Container images use their configured root disk storage.
The underlying service account also needs access to the source image.

Customers choose one destination when several rules apply. The backend binds
the pool and trusted tags; clients cannot choose arbitrary pools, tags, storage
or nodes. The selected rule's limits apply to **all** VMs owned by that creator,
including personal and assigned VMs. Limits from different rules are never
summed. They are not an aggregate team quota. Use separate capacity controls if
a whole team needs one shared budget.

The creator remains recorded for usage, audit and expiry. Policy-created VMs
have `access_managed=1`: creator ownership does not bypass expired/removed OIDC
grants. A peer with a matching rule can operate the VM. Legacy assignments keep
their existing owner access. Existing per-customer expiry settings also apply to
policy-created servers; review automatic stop/deletion before granting creation.

Creation still follows upstream placement: **VM clones use the source template's
node; LXC uses the offered image's saved node**. Managing guests on multiple nodes
in one cluster works, including node lookup after migration. There is no target
node selector, load balancing, or independent multi-cluster connection here.

## Supported operations and ownership boundaries

| Resource | Policy operations |
|---|---|
| Any eligible VM/LXC, including guests never assigned in the panel | View, graphs, power, browser console, snapshot create/delete/rollback |
| Panel-assigned guests | Above, plus explicitly granted backup list/create/delete/file access and Windows update actions, subject to native feature settings |
| Creator's policy-managed server | Above, plus explicitly granted resize, delete and expiry extension; resize also requires the original creation destination to remain available |
| Other owner's server | Owner lifecycle controls remain unavailable |
| Policy-managed server | Reinstall, backup restoration, schedules and Tailscale are unavailable; their background lifecycle needs further policy integration |

Native settings can impose additional restrictions. Granting an action never
enables a globally disabled feature. Unassigned guests receive no fabricated
owner, backup history or lifecycle settings. In-progress provisioning continues
after a creator's claim expires; it does not retain a user session or accept
further user commands. Administrators can recover failed provisioning.

## Revocation and service-account rights

Only a random authorization reference is added to the signed session. Claims
are kept server-side in SQLite, tied to the account, issuer and subject; no
provider access or refresh tokens are stored. A lease ends at the earlier of
the ID-token expiry or `OIDC_AUTHORIZATION_MAX_AGE_SECONDS` (30–3600, default 300).
There is no silent refresh. The customer sees a **Sign in again** link when the
lease expires. Existing SSO at Authentik can make this a brief redirect, but
long interactive sessions currently need periodic reauthentication.

Policy edits are checked on requests; membership changes at the provider need
a new sign-in and are bounded by the existing lease. Guest/tag and positive pool
inventories cache for five seconds. Pool reads have a ten-second timeout and
fail closed once a cached result expires. Console handshakes reauthorize; open
consoles recheck every five seconds and have an exact claim-expiry timer. Logout
revokes the authorization reference, including a copied cookie's shared access.
These intervals and in-flight operations mean directory/resource changes are
not an instantaneous cancellation of already accepted work.
Password and passkey sessions do not inherit a previous OIDC session's claims.

Grant the service account `Pool.Audit` on each selected pool for
`GET /pools/<id>`, plus the VM rights for enabled operations. Cloning additionally
needs VM.Clone on the source, VM.Allocate / pool allocation on the destination,
Datastore.Audit / Datastore.AllocateSpace on selected storage, relevant VM.Config
rights, and SDN.Use/network access where applicable. Consult the installed
Proxmox version's effective privileges and the upstream setup guide. Do not
solve filtered pool inventories by granting datacenter-wide Administrator.

## API, deployment and rollback

Administrators can export the full versioned document with
`GET /api/admin/access-policy` and replace it with
`PUT /api/admin/access-policy`. The same strict validation backs the form.
An illustrative (not production) policy is in
[access-policy.example.json](access-policy.example.json).

Back up SQLite before upgrading. The migration is additive (`vms.access_managed`
and `oidc_authorizations`). Test on a copied database, verify least-privilege
Proxmox API access, and test two groups plus an unmapped user before enabling the
policy. Configure offered images, real destination storage, network behavior,
quotas and expiry deliberately. No rule is automatically enabled on upgrade.

**Disable the policy to revoke shared grants. Do not roll back to an unmodified
upstream image while policy-created VM rows remain:** upstream ignores
`access_managed` and would grant their recorded creators native owner access.
For an image rollback, stop the panel, restore a pre-extension database backup
or reconcile/unassign managed rows under maintenance first, and separately
reconcile VMs created since that backup. Preserve the JWT secret with backups.
A database restore alone does not delete or undo Proxmox guests.
