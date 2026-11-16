import { api, esc, loading, toast, fail, confirmAction } from "/shared/ui.js";

export function renderSharingAdmin(host, data, reload) {
  const s = data.settings;
  host.innerHTML = `<p>Public HTTPS and private TCP sharing use your own zrok 2 server. The panel never uses the hosted zrok instance.</p><form class="settings" data-sharing-settings>
    <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}>Enable zrok sharing</label>
    <label class="check"><input type="checkbox" name="publicEnabled" ${s.publicEnabled ? "checked" : ""}>Allow public HTTPS sharing</label>
    <label>Self-hosted zrok HTTPS address<input type="url" name="endpoint" value="${esc(s.endpoint)}" placeholder="https://zrok2.share.rcadea.cloud:9443"></label>
    <label>Public HTTPS share origin<input type="url" name="publicOrigin" value="${esc(s.publicOrigin)}" placeholder="https://share.rcadea.cloud:9443"></label>
    <label>Public namespace token<input name="namespace" value="${esc(s.namespace)}" required></label>
    <label>zrok administrator token<input type="password" name="adminToken" autocomplete="new-password" placeholder="${s.credentialConfigured ? "Configured — leave blank to keep" : "Not configured"}"></label>
    <p class="hint">Save disabled settings, then test the controller before enabling sharing. The database encrypts administrator tokens, client tokens and machine certificates. Disabling sharing revokes all managed accounts and shares.</p>
    <p class="hint">SSO permission sets need sharing.read to connect and sharing.manage to publish. OpenZiti permissions do not grant public exposure rights. Customer administrators receive sharing permissions through their role.</p>
    <button class="btn primary">Save zrok configuration</button></form>
    <div class="row"><button class="btn" data-sharing-check>Test self-hosted controller</button><button class="btn" data-sharing-reconcile>Refresh shares and retry revocations</button></div>
    <p role="status">${esc(s.checkError || (s.verifiedAt ? `Last successful check: ${s.verifiedAt}` : "Controller has not been checked."))}</p>
    <h3>VM sharing agents</h3><div class="table-wrap"><table class="table" data-admin-table="zrok agents"><thead><tr><th>Customer</th><th>VM</th><th>State</th><th>Actions</th></tr></thead><tbody>${data.agents.map((a) => `<tr><td>${a.customer_id}</td><td>${a.vmid}</td><td>${esc(a.state)}${a.error ? `<p>${esc(a.error)}</p>` : ""}</td><td><button class="btn danger" data-sharing-revoke="${a.vmid}">Revoke agent and shares</button></td></tr>`).join("")}</tbody></table></div>
    <h3>Application shares</h3><div class="table-wrap"><table class="table" data-admin-table="zrok shares"><thead><tr><th>Customer</th><th>VM</th><th>Type / port</th><th>State</th><th>Public address</th></tr></thead><tbody>${data.shares.map((a) => `<tr><td>${a.customer_id}</td><td>${a.vmid}</td><td>${esc(a.mode)} / ${a.port}</td><td>${esc(a.state)}${a.error ? `<p>${esc(a.error)}</p>` : ""}</td><td>${a.endpoints.map(esc).join("<br>")}</td></tr>`).join("")}</tbody></table></div>`;
  async function run(button, fn) {
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = loading("Working…");
    try {
      await fn();
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.innerHTML = label;
      }
    }
  }
  host.querySelector("[data-sharing-settings]").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (
      s.enabled &&
      !f.enabled.checked &&
      !(await confirmAction(
        "Disable zrok and revoke all managed VM shares and client accounts?",
        "Disable and revoke",
      ))
    )
      return;
    const body = {
      revision: s.revision,
      enabled: f.enabled.checked,
      publicEnabled: f.publicEnabled.checked,
      publicOrigin: f.publicOrigin.value,
      endpoint: f.endpoint.value,
      namespace: f.namespace.value,
      ...(f.adminToken.value ? { adminToken: f.adminToken.value } : {}),
    };
    await run(e.submitter, async () => {
      await api("/api/admin/private-access/zrok", { method: "PUT", body });
      f.adminToken.value = "";
      toast("zrok configuration saved");
    });
  };
  host.querySelector("[data-sharing-check]").onclick = (e) =>
    run(e.currentTarget, async () => {
      await api("/api/admin/private-access/zrok/check", {
        method: "POST",
        body: {},
      });
      toast("Self-hosted zrok controller check passed");
    });
  host.querySelector("[data-sharing-reconcile]").onclick = (e) =>
    run(e.currentTarget, () =>
      api("/api/admin/private-access/zrok/reconcile", {
        method: "POST",
        body: {},
      }),
    );
  host.querySelectorAll("[data-sharing-revoke]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          await confirmAction(
            "Revoke this VM’s zrok identity and all application shares?",
            "Revoke sharing agent",
          )
        )
          await run(b, () =>
            api(
              `/api/admin/private-access/zrok/agents/${b.dataset.sharingRevoke}`,
              { method: "DELETE" },
            ),
          );
      }),
  );
}
