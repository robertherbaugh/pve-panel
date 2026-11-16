import { readFileSync } from "node:fs";
import { agentExec } from "./agent.js";
import { guestPath, pve, sleep } from "./pve.js";
import { sharingError } from "./zrok-controller.js";
const installer = readFileSync(
  new URL("./zrok-host.sh", import.meta.url),
  "utf8",
);

export async function installZrokAgent(guest, id, bootstrap, check) {
  if (!/^[0-9a-f-]{36}$/.test(id))
    throw sharingError("Invalid sharing agent identity", 409);
  const path = guestPath(guest);
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
    const script = installer.replaceAll("__ACCOUNT_ID__", id);
    const result = await agentExec(
      path,
      ["/bin/bash", "-c", script],
      600000,
      JSON.stringify(bootstrap),
      { retryIfLost: false },
    );
    if (result.code !== 0) throw Error();
    await check();
  } catch {
    // Guest output can contain credentials. Never log or return it.
    throw sharingError(
      "zrok agent setup did not finish. Check the Linux guest agent, Python 3, systemd and outbound access, then retry.",
      502,
    );
  }
}
