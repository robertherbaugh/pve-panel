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
Full cluster VM audit access is required to count other guests.
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
Catalog resize, reinstall and full restore remain blocked until their integration preserves the offering.
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
Backup entitlement enforcement and HA activation need separate integration.

HA activation changes capacity requirements and service commitments.
Record the applicable SLA and MSA acceptance before activating HA for a customer VM.
HA restarts a VM after host failure. It does not eliminate downtime or replace backups.

### Networking

Use Headscale for initial private access.
Keep Proxmox SDN automation disabled during the pilot.
Check underlying guest isolation and network availability on every placement node.
Headscale rules alone do not isolate guests on their underlying LAN.

Customers control application exposure from their VMs.
They can install exposure software such as Cloudflare.
OpenZiti or zrok integration can follow as an optional service.
The current hosted Tailscale integration needs an extension before it can enroll guests in Headscale.

### Future billing

Charge for allocated reservations, including stopped VMs.
Record disk allocation by storage class and keep it billable while retained.
Keep backup service fees separate from Basic backup storage usage.
Define a backup storage measure before pricing compressed or deduplicated PBS data.

Catalog revisions preserve offering definitions.
Catalog creation records durable operations, encrypted temporary credentials, capacity reservations and allocation events.
Deletion closes the allocation after the panel checks VM absence.
Resize, storage changes, add-ons and adoption need additional allocation events.
Migration must not create a second charge for the same allocation.
Do not activate invoicing until allocation reconciliation and pricing rules are complete.

## Delivery sequence

1. Configure the catalog, customer profiles and capacity reserves.
2. Check datastore media, node permissions, template disks, network isolation and connectivity in the target cluster.
3. Enable catalog provisioning for selected customers after the infrastructure checks pass.
4. Pilot direct clones and stopped clone-and-migrate placement across eligible nodes.
5. Make resize, reinstall, restore and deletion preserve the offering and allocation history.
6. Integrate native Proxmox HA after storage, networking, spare capacity and service acceptance pass their checks.
7. Connect backup entitlements, Basic destinations, storage limits and usage records to existing backup operations.
8. Pilot with new VMs. Adopt or migrate existing VMs explicitly.

Use native Proxmox scheduling for HA guests. Avoid a second controller that independently migrates the same VMs.
Customers select offerings. Administrators maintain the infrastructure that can satisfy them.

## Administration API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/compute-catalog` | Read the catalog and revision. |
| PUT | `/api/admin/compute-catalog` | Save sizes, mappings and reserves with the current revision. |
| GET | `/api/admin/compute-catalog/inventory` | Read current Proxmox nodes and storage. |
| POST | `/api/admin/compute-catalog/preview` | Check observed capacity for a size, class and disk capacity. |
| GET | `/api/admin/customers/:id/compute-profile` | Read a customer's offerings. |
| PUT | `/api/admin/customers/:id/compute-profile` | Save offerings with current profile and catalog revisions. |

| GET | `/api/admin/compute-operations` | Review recent operations and provider diagnostics. |
| POST | `/api/admin/compute-operations/:id/reconcile` | Resume an identified VM or release a checked failed reservation. |

The customer portal exposes none of these administration routes.
Customers read eligible offerings at `/api/compute-offerings` and allocation events at `/api/compute-allocations`.
Catalog creates use `/api/vms` with an `Idempotency-Key` header.
The server fixes `backupClassId` to `basic`, `billingMode` to `reservation` and catalog `rollout` to `customer-opt-in`.
Clients cannot change these fields.
