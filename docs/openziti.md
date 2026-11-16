# Private access and OpenZiti pilot

The administrator's **Private Access** page shows OpenZiti, Headscale,
Tailscale, WireGuard and zrok, including disabled providers. Each supported
provider reports its configuration and enrollment status. A saved configuration
does not by itself prove that a provider is healthy. zrok is a planned integration.

OpenZiti provides access to individual VM services. It does not create customer
subnets, change Proxmox SDN or expose public applications. The first version
supports SSH on TCP 22 and Remote Desktop on TCP 3389. The hosting tunneler
forwards to `127.0.0.1` inside the VM. SSH keys, passwords and Windows account
permissions still apply to the final connection.

## Provider setup

Use a dedicated controller and edge router for customer access. Keep them
separate from infrastructure OpenZiti identities and services.

1. Install and back up a supported OpenZiti controller and edge router. Publish
   stable advertised DNS addresses that the panel, guest VMs and customer devices
   can reach. Configure valid TLS certificates and synchronize system clocks.
2. Protect the management API with network restrictions. The panel must reach
   `/edge/management/v1`. Customer tunnelers need the advertised client API and
   router listeners. The panel does not install this infrastructure or manage
   its firewall, certificates, persistence or upgrades.
3. Create a dedicated controller administrator for the panel. The integration
   checks management administrator access. Treat this as a privileged credential
   for the dedicated customer controller.
4. Give customer edge routers the `rcadea-customers` role attribute, or use a
   different exact role in the panel configuration. At least one must be online.
5. Remove service policies that grant `#all` identities. The panel rejects these
   policies, including ones after the first inventory page. Review other policies
   on the dedicated controller for unintended access. Keep the `host.v1` and
   `intercept.v1` configuration types available.
6. In **Private Access → OpenZiti**, save the controller HTTPS address,
   management credentials and router role with enrollment disabled. A private CA
   bundle is optional. TLS verification remains enabled. The panel rejects redirects.
7. Test the controller, then enable enrollment within five minutes of that test.
   Changing connection settings requires another successful test. Controller and
   router-role changes are blocked while managed objects remain.

Provider settings are stored in the panel database. The management password is
encrypted with the existing `JWT_SECRET` encryption mechanism. Back up and
protect both the database and that secret. The secret must remain stable across
restarts. The panel logs out management sessions after each operation.

## Customer permissions

Existing permission sets are preserved. Grant these actions explicitly where
customers use OIDC group or application-entitlement rules:

| Action | Capability |
| --- | --- |
| `view` | Required VM visibility in the same permission set. |
| `private-access.read` | View services, enroll a personal device, renew or revoke its access. |
| `private-access.manage` | Create or remove SSH/RDP services and download the VM hosting enrollment. |

Grant both private-access actions to a service administrator. Customer
administrators receive the actions through their existing administrator role.
Other customer roles require explicit grants. Customer membership, exact pool,
tag and VM selectors, disabled state and current OIDC authorization apply.
An imported pool VM can receive service access without an individual assignment.
An explicit assignment to another customer takes precedence.

## Enrollment and connection

The pilot uses manual tunneler installation and enrollment. It does not install
software in guest VMs or issue Headscale keys.

1. A customer service administrator selects the VM's **Remote access → OpenZiti**
   tab and adds an SSH or RDP service.
2. Download **VM enrollment** and transfer it securely to that VM. Install an
   appropriate OpenZiti tunneler there and enroll the hosting identity.
3. Each user selects **Enroll my device**, then enrolls the separate personal
   identity on the device from which they will connect. An identity is scoped to
   one service and one user. Do not share identity files.
4. Start or reload the appropriate tunnelers. Connect to the private
   hostname using an ordinary SSH or Remote Desktop client.

For a Linux tunneler that supports the `enroll` command:

```bash
umask 077
ziti-edge-tunnel enroll --jwt downloaded-enrollment.jwt --identity identity.json
```

Store the resulting identity in the tunneler's restricted identity directory
and follow that platform's service instructions. Remove the enrollment file
after successful use. The enrollment is a one-time credential. An expired or
consumed enrollment requires a new identity. GUI tunnelers can import enrollment
files through their native enrollment flow.

Enrollment JWTs are returned only in authenticated, uncached responses and
downloaded as files. The panel does not retain them in its database, audit log,
browser storage or page markup. The controller retains unused enrollment
credentials until consumption or expiry.

## Access lifetime and revocation

Personal device access lasts at most 15 minutes and cannot outlive the current
OIDC authorization lease. Renew before expiry with a current authorized panel
session. An expired access identity must be revoked and enrolled again. The
hosting identity is separate and remains until its service is removed.

The panel checks access periodically, normally every 30 seconds. It removes
device policies and identities after expiry, membership removal, disabled
accounts or revoked VM permissions. It removes services if the customer, VM
boundary or provider is disabled or removed. Each policy uses exact service
and identity IDs, with only the configured customer router role.

Revocation requires a reachable controller. A controller outage can delay
revocation beyond the recorded lease, including access held by enrolled
devices. The local expiry is not a controller-enforced network TTL. Do not
offer this pilot as an immediate-revocation SLA. Pending revocations remain
visible and are retried after connectivity returns. Disabling enrollment starts
revocation. It does not prove that every remote connection ended.

VM deletion, customer transfer, reinstall and restore are blocked while managed
services or their setup operations remain. Remove services first. This avoids
carrying service identities into a different customer or replacement VM.

## Recovery and operations

The panel reserves unique object names before controller creation calls. A
lost response retains its local record. Retrying the service setup recovers an
existing object only if its exact name, panel instance tag and owner tag match.
Restarting the panel preserves these records.

Use **Retry revocations** after restoring controller connectivity. Do not edit
object ownership tags or manually remove database rows to clear failures. For
an ambiguous creation outcome with no matching remote object, stop changes and
inspect the dedicated controller inventory and audit history. Check that the
original request can no longer complete before reconciling or removing its
reserved local object record. A failed ownership check requires provider review.

Back up the dedicated controller state, signing keys, TLS material and panel
database. Avoid restoring an old panel snapshot against a newer controller
without an inventory review: objects created after that snapshot can remain
outside the restored panel's records. Use unique panel databases per deployment.
do not run multiple independent panel processes against the same database.

Headscale and Tailscale continue to use the existing guest-agent integration
and `TAILSCALE_ENABLED` runtime gate. Their provider selector is also available
under **Private Access → Headscale**. WireGuard uses the existing gateway and
customer-subnet environment settings. This feature changes none of those guest
network configurations.
