# Server deletion

Administrators can power and delete visible assigned or unassigned guests. Templates and the VPN gateway are protected. Customer administrators can delete imported guests inside their organization boundary. A member can delete a shared VM only when a current OIDC permission rule explicitly grants both `view` and `delete`. Operators and viewers do not receive delete rights by default. Email domains do not grant VM permissions.

Both portals show a confirmation that requires the VM ID. The customer API also requires `confirmVmid` for imported guests; the admin API requires it for unassigned guests. Customer deletion requires a stopped VM. Admin deletion can stop the VM after confirmation. Proxmox locks, active compute work, backups, Windows updates and native HA must be resolved first. HA must be disabled before deletion.

The provider API identity needs Proxmox `VM.Allocate` on the target VM in addition to audit rights. Power control requires `VM.PowerMgmt`. These application changes do not add Proxmox ACLs or enable delete on existing OIDC rules. Verify token permissions before rollout to customers.

Deletion records retain the task ID independently of customer assignment. Restart recovery follows that task and verifies cluster-wide VM absence before releasing compute reservations. Unknown submissions are not repeated automatically. A deletion marked for review keeps reservations held and blocks reassignment and other mutations. Resolve the recorded Proxmox task or verify the outcome before another attempt.

Retained backups follow the configured retention policy. Their Basic storage reservations remain billable until those archives are explicitly removed. Deleting compute does not silently discard retained backup charges.
