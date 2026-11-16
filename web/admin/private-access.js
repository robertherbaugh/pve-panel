import { markedSections } from "./sections.js";
import { renderRemoteAccess } from "./compute-remote.js";
import { loading } from "/shared/ui.js";

export function renderPrivateAccess(
  host,
  { data, api, esc, toast, fail, confirmAction, reload },
) {
  let active = true;
  const status = (p) =>
    p.supported
      ? `${p.enabled ? "Enabled" : "Disabled"} · ${p.configured ? "Configured" : "Not configured"}`
      : "Planned";
  const provider = (id) => data.providers.find((p) => p.id === id);
  const card = (p) =>
    `<article class="security-card"><div class="section-head"><h3>${esc(p.name)}</h3><span class="pill ${p.enabled ? "pill-running" : ""}">${p.enabled ? "Enabled" : "Disabled"}</span></div><p>${esc(p.detail)}</p><p class="muted">${esc(status(p))} · ${p.health === "verified" ? "Controller check passed" : p.health === "error" ? "Controller check failed" : p.health === "revocation_pending" ? "Revocation pending" : p.supported ? "Health not checked" : "Integration unavailable"}</p>${p.connections == null ? "" : `<p>${p.connections} managed connection${p.connections === 1 ? "" : "s"}</p>`}</article>`;
  const z = data.openziti.settings;
  host.innerHTML = `<section data-section="Overview"><h2>Private access providers</h2><p class="muted">All providers remain visible. Configuration, enrollment and health are separate states.</p><div class="compute-classes">${data.providers.map(card).join("")}</div></section>
 <section data-section="OpenZiti"><h2>OpenZiti</h2>${card(provider("openziti"))}
 <form class="settings" data-ziti-settings>
 <label class="check"><input type="checkbox" name="enabled" ${z.enabled ? "checked" : ""}>Enable OpenZiti enrollment</label>
 <label>Controller HTTPS address<input type="url" name="controller" value="${esc(z.controller)}" placeholder="https://ziti.rcadea.cloud"></label>
 <label>Management username<input name="username" value="${esc(z.username)}" autocomplete="off"></label>
 <label>Management password<input type="password" name="password" autocomplete="new-password" placeholder="${z.credentialConfigured ? "Configured — leave blank to keep" : "Not configured"}"></label>
 <label>Customer edge router role<input name="routerRole" required value="${esc(z.routerRole)}"></label>
 <label>Public client HTTPS address<input type="url" name="clientUrl" value="${esc(z.clientUrl)}" placeholder="https://ctrl01.rcadea.cloud"></label>
 <label>Panel OIDC issuer<input type="url" name="panelIssuer" value="${esc(z.panelIssuer)}" placeholder="https://auth.rcadea.cloud/application/o/pve-panel/"></label>
 <label>Authentik JWT signer ID<input name="jwtSignerId" value="${esc(z.jwtSignerId)}"></label>
 <label>User SSO authentication policy ID<input name="userAuthPolicyId" value="${esc(z.userAuthPolicyId)}"></label>
 <label>Machine certificate authentication policy ID<input name="hostAuthPolicyId" value="${esc(z.hostAuthPolicyId)}"></label>
 <label class="check"><input type="checkbox" name="autoProvision" ${z.autoProvision ? "checked" : ""}>Enroll new Linux VMs during provisioning</label>
 <p class="hint">Users authenticate through Authentik. Machine agents use certificates. Automatic Linux enrollment requires the QEMU guest agent, Python 3 and systemd in the image, plus VM.GuestAgent.Unrestricted on the destination pool. It runs after cloud-init and does not change guest login credentials.</p>
 <label>Controller CA certificates (optional)<textarea name="caPem" rows="4" placeholder="PEM certificate bundle">${esc(z.caPem)}</textarea></label>
 <p class="hint">Use the dedicated customer controller. TLS certificate verification stays on. The database encrypts the management password.</p>
 <p class="hint">Save configuration with enrollment disabled, then test the controller before enabling enrollment. Disabling enrollment revokes managed services and access identities.</p>
 <button class="btn primary">Save OpenZiti configuration</button></form>
 <div class="row"><button class="btn" data-ziti-check>Test controller</button><button class="btn" data-ziti-reconcile>Retry revocations</button></div>
 <p role="status" data-ziti-status>${esc(z.checkError || (z.verifiedAt ? `Last successful check: ${z.verifiedAt}` : "Controller has not been checked."))}</p>
 <h3>Managed VM services</h3><p class="hint">Access is time limited and rechecked against customer membership and VM permissions. Pending revocations remain visible until the controller confirms removal.</p>
 <div class="table-wrap"><table class="table" data-admin-table="OpenZiti services"><thead><tr><th>Customer</th><th>VM ID</th><th>Service</th><th>Address</th><th>State</th><th>Actions</th></tr></thead><tbody>${data.openziti.services.map((s) => `<tr><td>${esc(s.customerName || String(s.customer_id))}</td><td>${s.vmid}</td><td>${esc(s.kind.toUpperCase())}</td><td>${esc(s.hostname)}</td><td>${esc(s.state)}${s.error ? `<p class="small">${esc(s.error)}</p>` : ""}</td><td><button class="btn danger" data-ziti-remove="${s.id}">Revoke service</button></td></tr>`).join("")}</tbody></table></div>
 <h3>Access identities</h3><div class="table-wrap"><table class="table" data-admin-table="OpenZiti access identities"><thead><tr><th>Identity</th><th>User ID</th><th>Access expires</th><th>State</th></tr></thead><tbody>${data.openziti.grants.map((g) => `<tr><td>${esc(g.id)}</td><td>${g.user_id}</td><td>${esc(new Date(g.expires_at * 1000).toLocaleString())}</td><td>${esc(g.state)}${g.error ? `<p class="small">${esc(g.error)}</p>` : ""}</td></tr>`).join("")}</tbody></table></div></section>
 <section data-section="Headscale">${card(provider("headscale"))}<div data-headscale-settings></div><p class="hint">VM enrollment runtime: ${data.tailscaleRuntimeEnabled ? "Enabled" : "Disabled"}. The provider must set TAILSCALE_ENABLED=true to permit enrollment. Existing connections retain their recorded control server.</p></section>
 <section data-section="Tailscale">${card(provider("tailscale"))}<p>Use the control server selector in Headscale to choose Tailscale or Headscale for new VM connections.</p><p class="hint">VM enrollment runtime: ${data.tailscaleRuntimeEnabled ? "Enabled" : "Disabled"}.</p>
 <div class="table-wrap"><table class="table" data-admin-table="Private VM connections"><thead><tr><th>Customer</th><th>VM ID</th><th>Provider</th><th>Address</th><th>State</th></tr></thead><tbody>${data.connections.map((c) => `<tr><td>${esc(c.email)}</td><td>${c.vmid}</td><td>${esc(c.provider)}</td><td>${esc(c.ip || "—")}</td><td>${esc(c.state)}</td></tr>`).join("")}</tbody></table></div></section>
 <section data-section="WireGuard">${card(provider("wireguard"))}<dl class="specs"><div><dt>Gateway VM</dt><dd>${data.wireguard.gatewayVmid || "Not configured"}</dd></div><div><dt>Endpoint</dt><dd>${esc(data.wireguard.endpoint || "Not configured")}</dd></div><div><dt>Customer subnet integration</dt><dd>${data.wireguard.networksEnabled ? "Enabled" : "Disabled"}</dd></div></dl><p class="hint">This legacy gateway requires VPN_ENABLED, VPN_GATEWAY_VMID, VPN_ENDPOINT and CUSTOMER_NETWORKS. Other providers do not need Proxmox SDN.</p><div data-wireguard-devices></div></section>
 <section data-section="zrok">${card(provider("zrok"))}<p>zrok application sharing is a separate future integration. OpenZiti enrollment does not enable public application sharing.</p></section>`;
  markedSections(host, "Private access");
  renderRemoteAccess(host.querySelector("[data-headscale-settings]"), {
    api,
    esc,
    onSave: reload,
  });
  async function run(button, fn) {
    if (button.disabled) return;
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = loading("Working…");
    try {
      await fn();
      if (active) await reload();
    } catch (err) {
      if (active) {
        host.querySelector("[data-ziti-status]").textContent = err.message;
        fail(err);
      }
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.innerHTML = label;
      }
    }
  }
  host.querySelector("[data-ziti-settings]").onsubmit = async (event) => {
    event.preventDefault();
    const f = event.currentTarget;
    if (
      z.enabled &&
      !f.enabled.checked &&
      !(await confirmAction(
        "Disable OpenZiti and revoke all managed customer services and identities?",
        "Disable and revoke",
      ))
    )
      return;
    const body = {
      revision: z.revision,
      enabled: f.enabled.checked,
      controller: f.controller.value,
      username: f.username.value,
      routerRole: f.routerRole.value,
      caPem: f.caPem.value,
      clientUrl: f.clientUrl.value,
      panelIssuer: f.panelIssuer.value,
      jwtSignerId: f.jwtSignerId.value,
      userAuthPolicyId: f.userAuthPolicyId.value,
      hostAuthPolicyId: f.hostAuthPolicyId.value,
      autoProvision: f.autoProvision.checked,
    };
    if (f.password.value) body.password = f.password.value;
    await run(event.submitter, async () => {
      await api("/api/admin/private-access/openziti", { method: "PUT", body });
      f.password.value = "";
      toast("OpenZiti configuration saved");
    });
  };
  host.querySelector("[data-ziti-check]").onclick = (e) =>
    run(e.currentTarget, async () => {
      await api("/api/admin/private-access/openziti/check", {
        method: "POST",
        body: {},
      });
      toast(
        "Controller authentication, config types and customer router passed",
      );
    });
  host.querySelector("[data-ziti-reconcile]").onclick = (e) =>
    run(e.currentTarget, () =>
      api("/api/admin/private-access/openziti/reconcile", {
        method: "POST",
        body: {},
      }),
    );
  host.querySelectorAll("[data-ziti-remove]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          await confirmAction(
            "Revoke this VM service and all its access identities?",
            "Revoke service",
          )
        )
          await run(b, () =>
            api(
              `/api/admin/private-access/openziti/services/${b.dataset.zitiRemove}`,
              { method: "DELETE" },
            ),
          );
      }),
  );
  return () => {
    active = false;
  };
}
