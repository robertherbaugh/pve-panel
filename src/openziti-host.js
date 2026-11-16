import { readFileSync } from "node:fs";
import { db } from "./db.js";
import { pve, sleep } from "./pve.js";
import { agentExec } from "./agent.js";
import { zitiError } from "./openziti-controller.js";

const installer = readFileSync(
  new URL("./openziti-host.sh", import.meta.url),
  "utf8",
);
const uuid = /^[a-f0-9-]{36}$/;

export async function enrollZitiHost({
  service,
  node,
  identityId,
  enrollment,
  check,
}) {
  if (!uuid.test(service.id) || !/^[A-Za-z0-9_.-]{1,128}$/.test(identityId))
    throw zitiError("Invalid machine enrollment identity", 409);
  const path = `/nodes/${encodeURIComponent(node)}/qemu/${service.vmid}`;
  const unit = `rcadea-ziti-host@${service.id}.service`;
  const marker = `/var/lib/rcadea-ziti/${service.id}/controller-identity`;
  const status = [
    "/bin/bash",
    "-c",
    `test "$(cat ${marker} 2>/dev/null)" = '${identityId}' && test -s /var/lib/rcadea-ziti/${service.id}/identity.json && systemctl is-active --quiet ${unit}`,
  ];
  db.prepare(
    "UPDATE openziti_services SET host_state='installing',host_error=NULL WHERE id=?",
  ).run(service.id);
  try {
    await check();
    const deadline = Date.now() + 180000;
    for (;;) {
      try {
        await pve.post(`${path}/agent/ping`);
        break;
      } catch {
        if (Date.now() >= deadline) throw Error();
        await sleep(3000);
      }
    }
    await check();
    const existing = await agentExec(path, status, 30000);
    if (existing.code !== 0) {
      const jwt = await enrollment();
      await check();
      const script = installer
        .replace("__SERVICE_ID__", service.id)
        .replace("__IDENTITY_ID__", identityId);
      // Never repeat an enrollment blindly if QGA loses the process result.
      try {
        const result = await agentExec(
          path,
          ["/bin/bash", "-c", script],
          600000,
          jwt,
          { retryIfLost: false },
        );
        if (result.code !== 0) throw Error();
      } catch {
        const result = await agentExec(path, status, 30000);
        if (result.code !== 0) throw Error();
      }
    }
    await check();
    db.prepare(
      "UPDATE openziti_services SET host_state='enrolled',host_error=NULL WHERE id=?",
    ).run(service.id);
    return { ok: true };
  } catch {
    // Agent command errors and output must never expose the enrollment material.
    const message =
      "Machine enrollment did not finish. Check guest-agent access, cloud-init, Python 3, systemd and outbound HTTPS, then retry.";
    db.prepare(
      "UPDATE openziti_services SET host_state='error',host_error=? WHERE id=?",
    ).run(message, service.id);
    throw zitiError(message, 502);
  }
}
