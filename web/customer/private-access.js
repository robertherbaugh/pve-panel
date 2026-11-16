import { api, esc, loading, toast, fail, confirmAction } from "/shared/ui.js";
function downloadEnrollment(result) {
  const blob = new Blob([result.jwt], { type: "application/jwt" }),
    url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = result.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function renderOpenZiti(host, { vmid, manage, current }) {
  host.innerHTML = `<p role="status">${loading("Checking OpenZiti…")}</p>`;
  let data;
  try {
    data = await api(`/api/vms/${vmid}/private-access`);
  } catch (err) {
    if (current()) host.innerHTML = `<p role="alert">${esc(err.message)}</p>`;
    return;
  }
  if (!current()) return;
  host.innerHTML = `<h2>OpenZiti service access</h2><p><span class="pill ${data.enabled ? "pill-running" : ""}">${data.enabled ? "Enabled" : "Disabled"}</span> · ${data.configured ? "Controller configured" : "Controller not configured"}</p>
 <p class="muted">Connect to SSH or Remote Desktop without exposing the VM’s subnet. Your VM login credentials still apply.</p>
 <p class="hint">Your device signs in through Authentik. The VM agent uses a machine certificate, installed during provisioning when enabled. Guest SSH or Windows credentials still apply.</p>
 ${manage ? `<form class="row" data-add-service><label>VM service<select name="kind"><option value="ssh">SSH (TCP 22)</option><option value="rdp">Remote Desktop (TCP 3389)</option></select></label><button class="btn primary" ${data.enabled ? "" : "disabled"}>Add or retry service</button></form>` : ""}
 <div class="security-card"><h3>Connect with Authentik</h3><p>In a current OpenZiti client, add the controller URL below and sign in through Authentik. One user identity supports all of your granted services.</p><p class="mono selectable">${esc(data.clientUrl || "Controller not configured")}</p><p class="hint">For Linux with a running OpenZiti tunneler:</p><pre class="mono selectable">ziti-edge-tunnel add --identity rcadea --url ${esc(data.clientUrl)} --enroll-to-mode none</pre></div>
 <p class="hint">Each VM-service grant lasts up to 15 minutes, bounded by current SSO authorization. Renew before expiry. Revocation is reconciled every 30 seconds and requires controller connectivity.</p>
 <div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th>Private address</th><th>Status</th><th>Actions</th></tr></thead><tbody>${data.services
   .map(
     (
       s,
     ) => `<tr data-ziti-service="${s.id}"><td>${esc(s.kind.toUpperCase())}</td><td class="mono selectable">${esc(s.hostname)}:${s.kind === "ssh" ? 22 : 3389}</td><td>${esc(s.state)} · VM agent: ${esc(s.host_state)}${s.host_error ? `<p>${esc(s.host_error)}</p>` : ""}${s.error ? `<p>${esc(s.error)}</p>` : ""}${s.grants.map((g) => `<p>${esc(g.state)} · expires ${esc(new Date(g.expires_at * 1000).toLocaleTimeString())}${g.error ? ` · ${esc(g.error)}` : ""}</p>`).join("")}</td><td class="actions"><div class="row">
 ${manage ? `${s.kind === "ssh" ? `<button class="btn" data-install="${s.id}" ${data.enabled && s.state === "ready" && s.host_state !== "installing" ? "" : "disabled"}>${s.host_state === "enrolled" ? "Check VM agent" : "Install VM agent"}</button>` : ""}<button class="btn" data-host="${s.id}" ${data.enabled && s.state === "ready" ? "" : "disabled"}>Download VM enrollment</button>` : ""}
 ${!s.grants.length ? `<button class="btn primary" data-access="${s.id}" ${data.enabled && s.state === "ready" ? "" : "disabled"}>Enable my SSO access</button>` : s.grants.map((g) => `<button class="btn" data-renew="${g.id}" ${data.enabled && g.state === "active" ? "" : "disabled"}>Renew access</button><button class="btn danger" data-revoke="${g.id}">Revoke my access</button>`).join("")}
 ${manage ? `<button class="btn danger" data-remove="${s.id}">Remove service</button>` : ""}</div></td></tr>`,
   )
   .join("")}</tbody></table></div>
 ${!data.services.length ? '<p class="muted">No OpenZiti services have been created for this VM.</p>' : ""}
 <div data-enrollment-result role="status"></div>`;
  async function action(
    button,
    path,
    method = "POST",
    body = {},
    download = false,
  ) {
    if (button.disabled) return;
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = loading("Working…");
    try {
      const result = await api(path, {
        method,
        ...(method === "DELETE" ? {} : { body }),
      });
      if (!current()) return;
      if (download) {
        downloadEnrollment(result);
        toast(
          "Enrollment file downloaded. Enroll it only on the intended device.",
        );
      }
      await renderOpenZiti(host, { vmid, manage, current });
      if (download && current())
        host.querySelector("[data-enrollment-result]").innerHTML =
          `<p>Downloaded <code>${esc(result.filename)}</code>. After installing the tunneler, enroll this file on the intended device:</p><pre class="mono selectable">ziti-edge-tunnel enroll --jwt ${esc(result.filename)} --identity identity.json</pre><p class="hint">Store the identity using your tunneler’s secure identity directory, then start or reload the tunneler. Delete the enrollment file after use. A consumed or expired enrollment cannot be downloaded again.</p>`;
    } catch (err) {
      if (current()) fail(err);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.innerHTML = label;
      }
    }
  }
  host
    .querySelectorAll("[data-install]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(
            b,
            `/api/private-access/services/${b.dataset.install}/host-installation`,
          )),
    );
  const form = host.querySelector("[data-add-service]");
  if (form)
    form.onsubmit = (e) => {
      e.preventDefault();
      action(e.submitter, `/api/vms/${vmid}/private-access/services`, "POST", {
        kind: form.kind.value,
      });
    };
  host
    .querySelectorAll("[data-host]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(
            b,
            `/api/private-access/services/${b.dataset.host}/host-enrollment`,
            "POST",
            {},
            true,
          )),
    );
  host
    .querySelectorAll("[data-access]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(
            b,
            `/api/private-access/services/${b.dataset.access}/access`,
            "POST",
            {},
            false,
          )),
    );
  host
    .querySelectorAll("[data-renew]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(b, `/api/private-access/grants/${b.dataset.renew}/renew`)),
    );
  host.querySelectorAll("[data-revoke]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          await confirmAction(
            "Revoke your access to this service on all of your devices? You can enable it again with a current SSO session.",
            "Revoke access",
          )
        )
          action(b, `/api/private-access/grants/${b.dataset.revoke}`, "DELETE");
      }),
  );
  host.querySelectorAll("[data-remove]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          await confirmAction(
            "Remove this VM service and revoke all of its access identities?",
            "Remove service",
          )
        )
          action(
            b,
            `/api/private-access/services/${b.dataset.remove}`,
            "DELETE",
          );
      }),
  );
}
