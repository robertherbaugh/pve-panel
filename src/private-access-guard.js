import { db } from './db.js';

// Held before the first asynchronous authorization check. Lifecycle preflight
// checks this set as well as durable service rows, so neither operation can
// pass while the other is still waiting on Proxmox.
const settingUp = new Set();
export async function withPrivateAccessSetup(vmid, fn) {
  if (settingUp.has(vmid))
    throw Object.assign(new Error('Private access setup is already running'), {
      statusCode: 409,
    });
  settingUp.add(vmid);
  try {
    return await fn();
  } finally {
    settingUp.delete(vmid);
  }
}
export function privateAccessBlocks(vmid) {
  return (
    settingUp.has(vmid) ||
    !!db.prepare('SELECT 1 FROM openziti_services WHERE vmid=?').get(vmid)
  );
}
export function assertNoPrivateAccess(vmid, operation) {
  if (privateAccessBlocks(vmid))
    throw Object.assign(
      new Error(
        `Remove OpenZiti services and wait for access setup before ${operation} this VM`,
      ),
      { statusCode: 409, expose: true },
    );
}
