# Private access with Authentik and OpenZiti

The **Private Access** page shows OpenZiti, Headscale, Tailscale, WireGuard and zrok.
Each provider reports its configuration and enrollment state. zrok remains a planned integration.

OpenZiti connects users to individual VM services without a customer subnet or Proxmox SDN.
The supported services are SSH on TCP 22 and Remote Desktop on TCP 3389.
The machine agent forwards each service to `127.0.0.1` inside its VM.
Guest SSH keys, passwords and Windows account permissions still apply.

## Identity and authorization

| Identity | Authentication | Authorization |
| --- | --- | --- |
| Human user | Authentik browser login through an external JWT signer | Exact VM-service grants from the panel |
| VM agent | A certificate from one-time machine enrollment | Bind access to its exact service |
| Panel management account | Encrypted controller credential | Administrator of the dedicated customer controller |

Use a separate Authentik application and public OIDC client for OpenZiti.
Its authorization code flow uses PKCE with S256 and exact native client callback URLs.
Request `openid profile offline_access` to permit token refresh.
The controller checks the token signature through JWKS, issuer, audience and expiry.
The user authentication policy requires the selected signer and refuses certificate and password authentication.
It also requires that signer as a secondary authentication factor.
Keep certificate authentication enabled only in the separate machine policy.

The panel pre-creates an OpenZiti user identity only after an authorized service access request.
Directory login does not enroll unknown identities or grant services.
Disable certificate and token auto-enrollment on the external JWT signer.
Do not map directory groups directly to broad OpenZiti service roles.
The panel retains control of customer membership, groups, entitlements and VM selectors.

One OpenZiti user identity supports multiple devices and VM-service grants.
Its external ID must match the panel's immutable OIDC subject.
Configure both Authentik providers to use `hashed_user_id`, which resolves to the same immutable `user.uid`.
Check this mapping before enabling access. Never match identities by email or domain.
Other providers can issue different subject values for different OIDC clients.

## Controller setup

Use a dedicated customer controller and edge router, with public client and router listeners.
Restrict the management API to the panel and operator networks.
Use verified TLS and maintain controller backups, certificates and system clocks.

1. Create the Authentik public OIDC client, JWT signer and separate authentication policies.
2. Give an online edge router the exact `rcadea-customers` role, or configure another exact role.
3. Remove service policies that grant `#all` identities. The panel checks all policy pages.
4. Keep the controller's `host.v1` and `intercept.v1` configuration types available.
5. Save the disabled configuration in **Private Access → OpenZiti**.
6. Enter the public client URL, panel OIDC issuer, JWT signer ID and both authentication policy IDs.
7. Test the controller, then enable access within five minutes of that test.

Connection or authentication changes require another controller check.
The panel blocks changes to controller, router and identity settings while managed objects remain.
The controller check rejects user certificate fallback, broad signer lists and machine policies that require interactive login.

The panel stores provider settings in its database.
It encrypts the management password with the existing `JWT_SECRET` mechanism.
Protect and back up both the database and that stable secret.
The panel rejects controller redirects and closes management sessions after each operation.

## Customer permissions

Existing permission sets remain unchanged. Add these actions to the applicable OIDC rules:

| Action | Capability |
| --- | --- |
| `view` | Required visibility in the same permission set |
| `private-access.read` | Enable, renew and revoke the user's service access |
| `private-access.manage` | Create services, install machine agents and download machine enrollment files |

Customer administrators also receive these capabilities through their existing role.
Pool membership, exact VM and tag selectors, explicit assignments and current OIDC authorization apply.
An explicit assignment to another customer takes precedence over a pool match.
Users must sign in through the configured OIDC provider to enable or renew network access.
A local password session cannot borrow the linked account's SSO identity.

## Automatic Linux machine provisioning

Enable **Enroll new Linux VMs during provisioning** after the image and token checks pass.
This setting applies to new Linux QEMU VMs and Linux reinstalls.

The image must contain the QEMU guest agent, Python 3, `flock`, cloud-init and systemd.
Enable the guest agent in the Proxmox image configuration.
Keep machine identities and enabled RCADEA host services out of reusable images.
The guest must reach GitHub over HTTPS, the public controller API and the edge router.
The panel token needs `VM.GuestAgent.Unrestricted` on the destination customer pool.
This privilege permits guest command execution. Keep its ACL limited to the intended customer pools.

After the first boot, the panel waits for the guest agent and cloud-init.
It creates an SSH service and a certificate-only machine identity.
The guest agent supplies the one-time enrollment token on the installer's standard input.
The token never enters cloud-init user data, process arguments, the panel database or audit records.
The installer removes its temporary token file after use.

The installer downloads OpenZiti tunneler `1.20.0` and checks the pinned archive SHA-256 before installation.
It supports Linux x86-64 and ARM64 images that meet the prerequisites.
It starts a host-only systemd service without a TUN interface or guest route changes.
The certificate identity stays in a root-only directory and the service starts at boot.

A failed private-access installation leaves the VM available through its existing guest credentials and console.
The service reports the enrollment failure. Select **Install VM agent** to retry.
A lost guest-agent result triggers a status check before another enrollment attempt.
Long guest installation calls do not block access reconciliation.
An expired or consumed token without a usable guest identity requires service removal and creation again.

## Existing VMs and Windows

A service administrator can add a service under **Remote access → OpenZiti**.
For an existing Linux QEMU VM, select **Install VM agent** for the same guest-agent installation flow.
Windows and container agent installation remain manual in this release.
Download **VM enrollment** only for the intended machine and install its platform's OpenZiti tunneler.

For a compatible Linux tunneler:

```bash
umask 077
ziti-edge-tunnel enroll --jwt machine-enrollment.jwt --identity identity.json
```

Protect the resulting identity and remove the enrollment file after use.
Machine enrollment downloads require a current service management permission and use uncached authenticated responses.
User access never returns a certificate enrollment token.

## User browser login

1. Sign in to the panel through Authentik and select **Enable my SSO access** for the VM service.
2. Add the public controller URL in a current OpenZiti client.
3. Select the Authentik provider and complete browser authentication.
4. Connect to the service's private hostname with an ordinary SSH or Remote Desktop client.

The Linux flow passed checks with `ziti-edge-tunnel 1.20.0`.
For a running Linux tunneler, create a bootstrap identity without certificate enrollment:

```bash
ziti-edge-tunnel add --identity rcadea --url https://ctrl01.rcadea.cloud --enroll-to-mode none
```

Use the client's **Authenticate** action and select **RCADEA Authentik**.
For CLI authentication, substitute the actual identity file path:

```bash
ziti-edge-tunnel ext-jwt-login --identity /path/to/rcadea.json --provider 'RCADEA Authentik'
```

The client opens or returns the browser URL. It keeps its tokens on the user's device.
The panel never receives the OpenZiti client's access or refresh tokens.

## Access lifetime and revocation

Each VM-service grant lasts at most 15 minutes, bounded by the panel's current OIDC authorization lease.
Renew it with a current authorized panel session.
Network token refresh does not extend the panel's VM-service grant.
Re-enabling an expired grant reuses the same directory identity mapping and needs no user certificate.
Revoking a grant removes that service from all of the user's devices.
Other current grants remain valid.

The panel normally reconciles access every 30 seconds.
It revokes grants after expiry, membership removal, disabled accounts or loss of VM permissions.
Directory claim changes take effect when the panel refreshes or expires that authorization lease.
A controller outage can delay removal beyond the local lease.
Existing connections do not necessarily close when an OIDC token expires or an Authentik browser session ends.
This release does not promise immediate revocation during outages.

Disabling the provider starts durable service and identity revocation.
Pending cleanup remains visible and retries after controller recovery.
The panel also removes legacy personal certificate grants during reconciliation.
VM deletion, transfer, reinstall and restore remain blocked while services or setup operations exist.
Remove the services first.

## Recovery

The panel reserves object names before controller creation requests.
It recovers a lost response only when the name and ownership tags match.
Use **Retry revocations** after controller connectivity returns.
An ambiguous creation outcome or ownership mismatch requires provider inventory review.
Do not remove database records to hide a failed revocation.

Back up the controller, signing keys, machine identities, Authentik configuration and panel database.
Review inventories before combining database backups from different times.
Run one panel process per database.

Headscale and Tailscale retain their guest-agent integration and `TAILSCALE_ENABLED` runtime gate.
WireGuard retains its gateway and customer-subnet settings.
OpenZiti does not change those guest networks or enable zrok application sharing.
