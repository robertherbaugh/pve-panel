# Compute catalog and self-service placement

The compute catalog defines VM sizes, storage classes and customer offerings in SQLite.
Administrators configure it under **Compute** in the administration portal.

## Current implementation

This release provides the catalog, capacity preview and optional catalog provisioning for new VMs.
Each customer starts with catalog provisioning disabled.
Enable it after you map storage and check the customer's existing guest network.
The customer selects an available size, storage class and disk capacity.
The server derives CPU and memory from the selected size.
All example sizes and storage classes start disabled.
Catalog changes retain their previous revisions.

The API rejects stale catalog and customer edits.
A customer profile can restrict VM sizes and storage classes without granting VM operation permissions.
Membership, OIDC permission sets and existing customer quotas remain separate controls.

The capacity preview reads Proxmox node and datastore inventories.
It checks reported CPU count, current free memory, storage availability, VM disk support and free disk space.
Host memory and datastore reserves reduce the reported available capacity.
Missing inventory produces an exclusion reason rather than an eligible destination.

A passing preview does not reserve resources or establish that a VM can run there.
Template compatibility, guest networks, CPU compatibility, maintenance state, permissions and concurrent reservations need additional checks before provisioning.
HA also needs a separate infrastructure assessment.

### Provisioning and recovery

Placement excludes offline and maintenance nodes, unreadable allocations, insufficient reserved capacity and unavailable customer bridges.
Both running and stopped guests count toward CPU and memory admission.
The initial policy allows one allocated vCPU per logical CPU.
Pending operations reserve capacity before the clone request.
The token needs full cluster VM audit access to count other guests.
Clone, pool configuration and datastore allocation rights are also required.

Direct cross-node clones require shared template volumes accessible from the destination.
For local template volumes, the panel creates a stopped clone on the source datastore.
It then migrates that clone to the reserved node and datastore before first boot.
A separate staging reservation protects temporary source storage capacity.
The token needs migration and staging storage allocation rights for this path.
The panel waits for the task on its source node and configures the VM on its destination node.
Catalog images currently support QEMU VMs with one data disk and at most one network interface.
The checked existing bridge and VLAN replace the image's guest network.
The panel does not enable or change Proxmox SDN.

A restart follows accepted clone tasks without submitting another clone.
Unknown clone or migration outcomes retain their reservations and require provider reconciliation under **Compute operations**.
Resume checks the VM marker, destination, pool and lock state.
Release requires a recorded terminal task and checked VM absence.
Unknown submissions cannot be released automatically.

Unresolved operations block customer mutations and provider reassignment.
Catalog resize preserves the datastore and storage class. The VM must be stopped.
The customer selects an enabled size and can grow the disk.
Resize records durable steps and replaces the previous capacity reservation after verification.
Catalog reinstall preserves the offering, VM ID, MAC address, storage class and destination node.
The VM must be stopped. New credentials apply before first boot.
Recorded delete and clone tasks support restart recovery. Unknown submissions retain their reservations.
Catalog restore pins the destination datastore and reapplies the reserved hardware and guest network before boot.
The VM must be stopped. The backup disk must fit within the current reservation.
Older, smaller disks grow to the reserved capacity. Accepted restore tasks resume after a restart.
An unknown restore submission needs provider investigation before another overwrite.
Existing creation and lifecycle operations continue for customers without catalog opt-in.
Do not enable catalog provisioning broadly before the pilot passes on the target infrastructure.

## Product decisions

| Class | Backing media | Use |
| --- | --- | --- |
| Basic | HDD | Economical capacity and all backup storage. |
| Standard | Enterprise SSD, excluding NVMe | General-purpose VM disks. |
| Fast | NVMe | VM disks that need higher performance. |

Administrators map explicit node and datastore pairs to a class and purpose.
VM disks can use any permitted class. Backup destinations can use Basic only.
The API rejects backup mappings to Standard or Fast.
A node/datastore pair cannot belong to different classes.
Node-local datastores can share a name while using different media on different nodes.
Check shared datastore mappings for consistent classification across nodes.

Proxmox storage types do not establish the physical media type.
Administrators must check the media before they map a destination.
Storage classes do not establish redundancy, HA eligibility or a performance guarantee.
Publish performance expectations separately from the media description.

The website currently advertises NVMe compute and SSD volumes.
Update that wording when publishing Basic disks.

### Customer offerings

Keep these settings separate:

- **Service tier:** Basecamp, Ridge or Summit.
- **VM size:** A catalog entry with vCPU, memory and minimum disk requirements.
- **Disk capacity and storage class:** Explicit capacity, independent of the VM size.
- **HA:** An optional add-on in every service tier, off by default.
- **Backup service:** An optional service with separate storage usage.

Ridge and Summit include the backup service fee.
No service tier includes backup storage capacity by default.
Including the service fee does not select a backup schedule.
All backups use Basic storage, regardless of the VM disk class.

Customer profiles can restrict sizes, classes and HA availability.
A null size list permits all enabled sizes, including future sizes. An empty list permits none.
Profiles also define class-specific disk limits and a separate backup storage limit.
A zero limit adds no cap beyond the existing aggregate customer quota.
Catalog creation enforces size restrictions, storage classes, class limits and existing aggregate quotas.
Catalog backups enforce service selection, Basic destinations and the shared backup quota.
HA availability also requires the provider’s enabled and verified native HA policy.

HA activation changes capacity requirements and service commitments.
Record the applicable SLA and MSA acceptance before activating HA for a customer VM.
HA restarts a VM after host failure. It does not eliminate downtime or replace backups.

### Native HA add-on

HA starts disabled. Customers create a VM, stop it, then use **HA Enabled** in its overview to request the add-on.
Only customer administrators with VM power permission can enable or disable it.
The provider must publish the SLA/MSA versions and terms and check at least three eligible nodes.
Infrastructure verification covers quorum, fencing/watchdog, CPU compatibility, redundant shared storage and guest networking.
The customer explicitly accepts the current agreement before activation. Policy revisions retain the accepted text.

Admission checks live quorum, active local resource managers, shared access to all VM volumes and placement eligibility on every selected node.
The token needs `Sys.Audit` and `Sys.Console` on `/` for HA inventory and management, in addition to catalog privileges.
Each HA VM conservatively reserves its entire CPU and memory allocation on every verified node.
These holds also reduce capacity for ordinary VM placement. This deliberately trades utilization for simple failover headroom.
The panel creates a stopped native HA resource and a strict positive node-affinity rule covering the verified nodes.
Proxmox controls ongoing HA placement and failover. The panel does not enable cluster-wide balancing or edit existing cluster rules.

Power actions update the HA requested state. Start and reboot check the panel’s affinity rule and reported rule errors.
Resize, reinstall, restore and deletion require HA to be disabled first.
Disabling HA requires a stopped resource, deletes the native resource and checks deletion of its affinity rule before releasing capacity.
Unknown enrollment or removal outcomes retain reservations for provider reconciliation.
Changes to infrastructure or agreement text require affected VMs to leave HA first.
Providers may stop offering new HA enrollments independently.

### Existing VM adoption

Providers use **Compute → Adopt an existing VM** after assigning a VM to an enabled customer.
Adoption requires the VM to be stopped and free of active tasks, native HA and unsupported host-specific settings.
Its CPU and memory must match an enabled permitted size. Its boot disk must use a mapped storage class on its current node.
The existing NIC must match the customer’s verified bridge, VLAN and firewall setting.
This release accepts one data disk and one guest NIC. It rejects unused volumes and custom cloud-init data.
Live placement, pool membership, current catalog/profile revisions and customer quota checks all apply.

The provider enters the current VM name to authorize adoption. The panel records allocation history and capacity reservations atomically.
Adoption preserves the guest’s configuration, disk, credentials and current node.
It enables customer lifecycle operations, including destructive reinstall and deletion, under the customer’s existing permissions.
A repeated adoption cannot create another active allocation.
Adoption does not revoke direct Proxmox access or move an incompatible VM. Plan those transitions separately.

### Networking

Use Headscale for initial private access.
Keep Proxmox SDN automation disabled during the pilot.
Check underlying guest isolation and network availability on every placement node.
Headscale rules alone do not isolate guests on their underlying LAN.

Customers control application exposure from their VMs.
They can install exposure software such as Cloudflare.
OpenZiti or zrok integration can follow as an optional service.
Providers select Tailscale or Headscale under **Compute → Private access enrollment**.
Headscale requires its HTTPS control server URL. Customers supply a pre-authentication key scoped to their customer.
Enrollment uses the Tailscale guest client and QEMU guest agent on Linux or Windows.
Keys pass through guest-agent stdin and a temporary restricted file. The panel does not retain them.
Changing the provider setting affects future connections. Existing connections retain their recorded control server.
Headscale users, key issuance and ACLs remain under the provider’s existing Headscale configuration.

### Future billing

Charge for allocated reservations, including stopped VMs.
Record disk allocation by storage class and keep it billable while retained.
Keep backup service fees separate from Basic backup storage usage.
Backup quotas reserve each VM’s logical disk capacity per backup.
Reported archive bytes remain separate from PBS physical usage.
Choose pricing rules for compressed or deduplicated PBS data before enabling invoices.

Catalog revisions preserve offering definitions.
Catalog creation records durable operations, encrypted temporary credentials, capacity reservations and allocation events.
Deletion closes the allocation after the panel checks VM absence.
Creation, resize, reinstall, restore, adoption and HA changes record allocation events.
Storage-class changes and independent volumes remain future work.
Migration must not create a second charge for the same allocation.
Do not activate invoicing until allocation reconciliation and pricing rules are complete.

## Guest sign-in

Customers save public SSH keys under **Account**.
The personal library shows each key's fingerprint and keeps other users' keys private.
Customers can select saved keys or paste public keys when creating a server.
They choose a username and one of three methods: SSH keys, username/password, or both.
Password login does not require an SSH key.
SSH key login does not require a password.

The panel configures cloud-init through the Proxmox API after cloning and before first boot.
It sets `ciuser`, encoded `sshkeys` and `cipassword` according to the selected method.
It clears cloud-init credentials from the template when the customer does not select that method.
Templates need a cloud-init drive and generated user data that accepts these settings.
The panel rejects custom user data that overrides the generated sign-in configuration.
Images must also be clean of embedded operating-system credentials before the provider offers them.

Customers connect to the VM's private address with their selected username and credentials.
The existing guest network must provide connectivity from their private access network.
OIDC authenticates the panel session. Guest sign-in uses the credentials selected for that VM.
Saved keys belong to the signed-in user across their customer memberships.
Removing a saved key affects future provisioning. Existing VM keys stay in place.
Reinstall can select new sign-in settings while preserving the catalog offering.
Windows images continue to use their Administrator password. Containers use root with the selected credentials.

The authenticated `/api/ssh-keys` endpoints list, save and delete personal public keys.
Create and reinstall requests accept `sshKeyIds` and `loginMethod` values of `ssh`, `password` or `both`.
The server resolves key IDs against the acting user's library before making Proxmox changes.

## Basic backup execution

Catalog customers must select the backup service before creating backups or schedules.
Customer administrators can change this selection under **Account → Customer add-ons**.
Turning it off deletes automatic schedules. Existing archives retain their ownership and storage reservations.
Turning it on does not create a schedule or change provider limits.
Ridge and Summit include the service fee. They do not automatically select or schedule the service.
Existing archives remain visible after the customer deselects the service.
The provider's configured backup storage must have an enabled Basic mapping on the VM's node.
The job checks live availability, allocation permissions and free capacity before calling vzdump.
Queued and scheduled jobs use the same checks.
Jobs retain their selected destination across settings changes and restarts.

A durable reservation enforces the customer's shared backup quota before the dump starts.
The quota uses logical VM disk capacity, including retained archives after VM deletion.
The ledger records archive bytes separately. They do not represent physical PBS consumption.
The panel releases the reservation after it checks archive deletion.
Active compute allocations and retained backup reservations block customer deletion, even after VM rows disappear.
Unknown outcomes retain their quota.
Providers can discover a completed archive by its job marker under **Compute operations**.
Customer administrators manage archives from deleted VMs under **Account → Retained backups**.
Protected archives cannot be deleted. Storage must be readable before absence can release a reservation.
If someone deleted an archive outside the panel, the same deletion action verifies its absence and releases its quota.
An unresolved submission without a matching archive needs manual provider investigation.
These records prepare usage accounting. They do not activate prices or invoices.

## Delivery sequence

1. Configure the catalog, customer profiles and capacity reserves.
2. Check datastore media, node permissions, template disks, network isolation and connectivity in the target cluster.
3. Enable catalog provisioning for selected customers after the infrastructure checks pass.
4. Pilot direct clones and stopped clone-and-migrate placement across eligible nodes.
5. Pilot resize, reinstall, restore and deletion, including interrupted task recovery.
6. Pilot native Proxmox HA after storage, networking, spare capacity and service acceptance pass their checks.
7. Pilot backup entitlements, Basic destinations, storage limits and retained usage records.
8. Pilot with new VMs. Adopt compatible assigned VMs explicitly. Plan other migrations separately.

Use native Proxmox scheduling for HA guests. Avoid a second controller that independently migrates the same VMs.
Customers select offerings. Administrators maintain the infrastructure that can satisfy them.

## Administration API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/compute-adoption` | List assigned VMs without a catalog allocation. |
| POST | `/api/admin/compute-adoption/:vmid` | Check and record an existing VM allocation. |
| GET / PUT | `/api/admin/compute-ha-policy` | Read or publish verified HA nodes and agreements. |
| GET / PUT | `/api/admin/remote-access` | Select Tailscale or a Headscale HTTPS control server. |
| GET | `/api/admin/compute-catalog` | Read the catalog and revision. |
| PUT | `/api/admin/compute-catalog` | Save sizes, mappings and reserves with the current revision. |
| GET | `/api/admin/compute-catalog/inventory` | Read current Proxmox nodes and storage. |
| POST | `/api/admin/compute-catalog/preview` | Check observed capacity for a size, class and disk capacity. |
| GET | `/api/admin/customers/:id/compute-profile` | Read a customer's offerings. |
| PUT | `/api/admin/customers/:id/compute-profile` | Save offerings with current profile and catalog revisions. |
| GET | `/api/admin/compute-backup-reservations` | Review Basic backup reservations. |
| POST | `/api/admin/compute-backup-reservations/:id/reconcile` | Find a completed archive after an uncertain result. |
| GET | `/api/admin/compute-operations` | Review recent operations and provider diagnostics. |
| POST | `/api/admin/compute-operations/:id/reconcile` | Resume an identified VM or release a checked failed reservation. |

The customer portal exposes none of these administration routes.
Customers read offerings at `/api/compute-offerings`, allocations at `/api/compute-allocations` and backup reservations at `/api/compute-backup-usage`.
Catalog creates use `/api/vms` with an `Idempotency-Key` header.
Customer administrators select the backup service at `/api/compute-services` and manage orphan archives at `/api/retained-backups`.
They read HA terms at `/api/compute-ha-policy` and change a stopped VM’s HA add-on at `/api/vms/:vmid/ha`.
The server fixes `backupClassId` to `basic`, `billingMode` to `reservation` and catalog `rollout` to `customer-opt-in`.
Clients cannot change these fields.
