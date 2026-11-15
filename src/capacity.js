import './compute-state.js';
import { db } from './db.js';
// One panel process serves both portals. Pending restores also reserve capacity
// durably, so a restart cannot let a clone race a queued restore.
export const capacityLocks = new Set();
export function capacityBusy(customerId) {
  return (
    capacityLocks.has(`customer:${customerId}`) ||
    !!db.prepare("SELECT 1 FROM compute_operations WHERE customer_id=? AND state NOT IN ('complete','cancelled')").get(customerId) ||
    !!db
      .prepare(
        "SELECT 1 FROM backup_jobs WHERE customer_id=? AND action='restore' AND state IN ('queued','running')",
      )
      .get(customerId)
  );
}
