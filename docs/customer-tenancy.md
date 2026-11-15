# Customers and access

A **user** is an identity. A **customer** is an organization that owns resources.
Users can belong to several customers, and each customer can have several users.
The customer portal requires an active customer context. Switching customers
reloads the portal and clears the previous server selection, forms and consoles.

The administration portal has separate **Customers**, **Users** and
**Permissions** tabs. A platform administrator can manage all customers. A
customer administrator can manage only their customer's membership and resources.
Customer administrator membership does not grant platform administration.

## Membership

Add existing panel users manually, or configure exact OIDC group names and
application entitlement values on the customer. Claims come from the validated
OIDC sign-in, using the configured groups and entitlements claim names. Choose
whether a group OR an entitlement is enough, or whether both are required.
The provider must include these claims in the ID token, and the panel must
request the scopes that provide them.

Email domains are an optional extra filter for **automatic membership**. Leave
this field empty when group/entitlement mappings are sufficient. A domain match
alone never creates membership or grants a VM operation. Global OIDC sign-in
restrictions configured through environment variables still apply to sign-in.

Automatic membership has the `member` role. This role grants no VM operations
on its own; a customer-scoped permission set must grant operations. Manual
membership may use these roles:

| Role | Access within the customer's resource boundary |
| --- | --- |
| Member | Only operations granted by matching permission sets |
| Viewer | View servers and graphs |
| Operator | View, console, power and snapshots |
| Admin | Manage customer membership and supported customer resource operations |

Cloning always requires an explicit permission set, except for a migrated
personal customer's existing self-service plan. Existing restrictions on
policy-created servers still apply: reinstall, backup restore/scheduling and
Tailscale management are not available for these servers. Deletion and resizing
also require a server created through the panel; provider-assigned VMs retain
their existing protection. Shared administrators can manage another creator's
server when the applicable operation is supported.

A migrated personal plan can create servers only when its configured destination
pool is within the customer's boundary, or no pool boundary is configured.
Use an explicit cloning permission set to offer another destination.

**Require a current SSO authorization** applies to all customer memberships,
including manual ones. When it is off, manual members may use any enabled
sign-in method. Automatic membership and claim-based operations always require
a current validated OIDC authorization. They expire at the configured claim
lease lifetime; the portal prompts for a fresh sign-in. Requesting
`offline_access` alone does not renew an authorization or implement claim refresh.

Removing membership blocks both manual access and future automatic rejoining
through the same SSO mappings. Re-add the user explicitly to approve membership
again. The last customer administrator cannot remove or demote themselves;
platform administrators can recover or change any membership. Disabling a user
blocks sign-in and active access while preserving memberships, VMs and backups.
Disabling a customer blocks all customer access without deleting resources.
Open consoles recheck identity, membership and permission grants every five
seconds, and OIDC-backed consoles also close when their authorization expires.

## Delete a customer

A platform administrator can select **Delete** in the Customers table.
The dialog lists the memberships, permission sets and pool mappings that deletion removes.
Type the customer ID to confirm. User accounts and Proxmox guests and pools remain intact.

Assigned VMs, private networks, VPN devices, Tailscale connections, backups and
backup schedules block deletion. Move or remove those resources first.
Wait for active provisioning, backup, restore and Windows update jobs to finish.
The panel checks these conditions again when you confirm deletion.

The deleted customer disappears from administration and customer selection.
Its SSO mappings cannot grant access again. Its former slug and pools become
available for another customer. Historical records and an internal deletion record
retain the original customer ID. The panel never reuses that ID, so an old customer
selection cannot select a replacement customer. Deleting a migrated personal
customer does not recreate it when the user next signs in.

## Resource boundaries and permissions

Configure exact Proxmox pool IDs on each customer. A pool belongs to one customer,
even if that customer is disabled. An empty pool selection allows only VMs
explicitly assigned to that customer in the Servers tab. Templates and the VPN
gateway are excluded from normal customer resource discovery.

A permission set belongs to one customer. Its resource pools must be a subset
of that customer's pools. Optional exact tags and VM IDs narrow the selection.
A matching group or entitlement cannot cross the customer boundary. A VM
explicitly assigned to a different customer remains private even if its Proxmox
pool matches another customer's permission set. Pool inventory failures deny
access; no cached permission is substituted after a failed refresh.

Changes to Proxmox pool membership are observed after the inventory cache expires
(up to five seconds). Edits to customers, memberships and permission sets are
checked on subsequent requests. Existing asynchronous operations already accepted
by the panel finish under their original customer and actor; disabling a user is
not a cancellation mechanism for an accepted clone or backup.

VM assignment now selects a customer. The historical creator stays on the VM
record and operation records retain the acting identity for audit. Tasks, backup
history, private networks and VPN devices carry customer ownership. Changing VM
assignment does not transfer previous customer backup history or schedules. Wait
for active jobs to finish and disconnect panel-managed Tailscale before moving a
VM to another customer. Review the VM’s network configuration when transferring
it; changing panel ownership does not move its network interfaces.

Customer shared quotas cover all its VMs, including unassigned VMs discovered
in its pools. A quota of zero means no additional aggregate cap. Clone permission
sets retain per-creator quotas within the active customer. Clones, resizes and
restores reserve shared capacity to prevent concurrent quota overshoot. The panel
uses one process for both portals; running several panel replicas against the
same database is not supported. External Proxmox changes are outside this quota
reservation mechanism.

Expiry, backup limits and an optional notification email are customer settings.
Existing per-VM expiry overrides remain valid. Setting a fixed expiry date applies
to customer VMs without a manual override; a relative expiry applies to future
clones. No invitations are sent by adding a membership. Optional user invitation
email remains an explicit action in the Users form.

## Upgrade

Back up the database before upgrading. The migration is automatic and preserves
existing users and resources:

- Each existing user receives a personal customer and a manual administrator
  membership. Their existing VM, network, VPN, task and backup records are
  attached to that customer. Existing expiry and backup limits are copied.
- Existing SSO permission rules move into a customer named **Imported SSO access**.
  Its pool boundary and membership mappings come from the existing rules; its
  optional domains come from the former global permission filter. Rename and
  review this customer after upgrading.
- Existing explicit assignments remain with their migrated personal customers.
  Review and reassign intended shared VMs to the organization. This avoids a
  pool mapping silently exposing an existing personal assignment.
- New users created in the UI or automatically by OIDC do not receive personal
  customers. Their membership is assigned manually or through trusted claims.
- The legacy user creation API defaults to a personal customer for compatibility;
  send `createPersonalCustomer: false` to create only an identity. The legacy
  VM assignment API and CLI still accept a user and resolve their personal
  customer. New integrations should use customer IDs.
- Legacy unscoped policy imports are converted to the imported SSO customer.
  Do not mix scoped and unscoped rules. New policy writes should include a
  `customerId` on every rule and leave global `allowedDomains` empty.

The migration is idempotent. Keep the pre-upgrade backup until the upgrade is
verified. **Do not run an older panel image against the migrated database**:
older code ignores customer boundaries. To downgrade, stop the panel and restore
the matching pre-upgrade database and image together.
