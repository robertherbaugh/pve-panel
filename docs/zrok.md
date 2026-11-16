# Self-hosted application sharing

The panel supports the zrok 2 API. RCADEA hosts the controller, frontend and overlay on its own Ziti VPS. No hosted zrok account is required. Configure the provider under **Private access → zrok**.

Public HTTPS shares publish an HTTP service on a VM's loopback port. Private TCP shares require a separate authorized client account. The application still controls its own authentication. OpenZiti SSH/RDP access remains a separate feature.

## Provider setup

1. Deploy a zrok 2 controller with agent remoting and a TLS frontend.
2. Create a closed namespace. Keep all other namespaces closed too.
3. Enter the self-hosted API origin, public HTTPS origin, namespace token and administrator token.
4. Save with sharing disabled.
5. Test the controller.
6. Enable sharing after the test passes.
7. Enable public HTTPS sharing separately when needed.

For example, the API can use `https://zrok2.share.rcadea.cloud:9443`, with public origin `https://share.rcadea.cloud:9443` and namespace token `public`. This preserves the existing native controller's port 443. The namespace's DNS name must match the configured public origin. The public origin supplies the external TLS port, because zrok's named-share metadata can return a bare hostname.

The controller check verifies the major API version, administrator access and closed namespaces. It does not prove that a VM agent or public frontend is reachable. Complete a real share, connection, restart and revocation check after deployment. A URL alone does not enable the provider. Disabling the provider revokes managed accounts and services, with durable retries during outages.

## Permissions and tenant isolation

`sharing.read` permits VM sharing inventory and connection to private shares. `sharing.manage` permits agent installation, publication, enable/disable and deletion. Both require normal VM visibility. Existing SSO policies receive neither action automatically. Customer administrators receive the actions through their role. OpenZiti's `private-access.*` actions do not grant sharing rights.

Each VM receives its own random provider account, certificate and remotely controlled agent. Each customer user receives a separate client account on first private connection. Client accounts have no public namespace grant. VM credentials do not enter customer API responses. Account credentials and certificates are encrypted in the panel database. Keep `JWT_SECRET` and compatible database backups for recovery.

Private shares use closed permission mode and explicit account grants. A routing token alone cannot grant access. A private connection returns the user's enable token in a response with `Cache-Control: no-store`. The interface never stores that token in local or session storage. Users must protect tokens and their enabled client environments.

The panel authorizes all requests against the selected customer, VM assignment and live pool membership. Shares target only `127.0.0.1` on the selected VM. Customers cannot submit another host, subnet, filesystem path, SOCKS target or unrestricted proxy. Public publication requires provider enablement and explicit customer confirmation. The first release limits each customer to 100 share records, including disabled records.

The provider namespace must stay closed. The panel grants namespace access only to managed machine accounts when publishing. Disabling public sharing removes those grants and stops managed public shares. A customer with root access to an enrolled VM can read that VM's local zrok credentials. Treat enrolled VM accounts as machine credentials with the VM's permitted sharing privileges.

## VM agents and persistence

Automatic installation supports running Linux QEMU VMs with Python 3, systemd and the guest agent. The Proxmox token needs guest command execution on the destination pool. Installation waits for cloud-init. It pins zrok 2.0.9 and verifies the published SHA-256 digest for AMD64 or ARM64. Enrollment material travels on guest-agent standard input. It does not enter process arguments or cloud-init data. Windows and LXC automatic installation are outside this release.

The agent runs as `rcadea-zrok-agent@<account-id>.service`. Its environment and encrypted-network identity remain under `/var/lib/rcadea-zrok/<account-id>/.zrok2`. The systemd service restarts after failure and boot. Removing an agent from the panel revokes its server-side identity. It leaves an unusable local service and certificate until the VM administrator removes them.

Public names remain reserved through stop/start. The agent retains reserved public shares. The panel restores ordinary private shares after restart because zrok treats those agent entries as ephemeral. A restored private share receives a new routing token. Reconciliation discovers the exact VM/type/loopback target and updates the panel. Private grants track the underlying service identity as well as the routing token, because a restored share can reuse its token. A lost creation response leaves a durable record. Retry discovers the existing share instead of publishing a duplicate.

The panel reconciles every 30 seconds. Current local user disables, customer disables, membership blocks, VM boundaries and permission changes trigger revocation. Provisioned SSO authorization uses the latest validated issuer/subject snapshot. Browser logout or short token expiry does not delete a share. New SSO sign-ins refresh groups and entitlements. Immediate directory-driven revocation additionally requires directory synchronization. A local disable or membership block does not wait for a new sign-in.

An offline agent can prevent removal of its saved restart request. The panel removes the known controller binding and retains a pending revocation until the agent confirms cleanup. Do not treat a pending revocation as completed. Provider disable and **Remove agent and all shares** delete the isolated account and its environments, even when the VM is offline. Managed agents block VM transfer, reinstall and deletion until cleanup completes. Managed accounts also block customer deletion.

## Customer connection

Open **Remote access → zrok** on a VM. Install the VM sharing agent. Select **Private TCP** or **Public HTTPS**, then enter the local service port. The public option appears only when the provider allows it.

For a private share, select **Connect privately**. Install the zrok 2 CLI on the device, then use the displayed self-hosted endpoint and personal enable token. The interface provides a loopback connection command. Use a separate zrok environment when the device is already enabled elsewhere. Hide the credentials after use.

Application shares remain provisioned until disabled, deleted or revoked by policy. This does not remove the requirement to protect application credentials, client identities and VM machine credentials.
