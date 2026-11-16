import { api, esc, loading, fail, toast, confirmAction } from "/shared/ui.js";

export async function renderSharing(host, { vmid, manage, current }) {
  host.innerHTML = `<p role="status">${loading("Checking application sharing…")}</p>`;
  let data;
  try {
    data = await api(`/api/vms/${vmid}/sharing`);
  } catch (e) {
    if (current()) host.innerHTML = `<p role="alert">${esc(e.message)}</p>`;
    return;
  }
  if (!current()) return;
  host.innerHTML = `<div class="section-head"><h2>Application sharing</h2><span class="pill ${data.enabled ? "pill-running" : ""}">${data.enabled ? "Enabled" : "Disabled"}</span></div>
    <p>Share a service on this VM through RCADEA’s self-hosted zrok server. Public links expose the selected application to the internet. Private shares require an authorized zrok client.</p>
    <p class="hint">OpenZiti provides private SSH and Remote Desktop access. zrok publishes an individual application or TCP service. VM credentials and application authentication still apply.</p>
    <article class="security-card section-stack"><h3>VM sharing agent</h3><p>${esc(data.agent?.state ?? "Not installed")}${data.agent?.error ? ` · ${esc(data.agent.error)}` : ""}</p><p class="hint">Linux QEMU VM, running guest agent, Python 3 and systemd required. Shares target only 127.0.0.1 on this VM. Agents and shares persist across restarts.</p>
    ${manage ? `<div class="row"><button class="btn primary" data-install-agent ${data.enabled ? "" : "disabled"}>${data.agent ? "Check or retry agent" : "Install sharing agent"}</button>${data.agent ? '<button class="btn danger" data-remove-agent>Remove agent and all shares</button>' : ""}</div>` : ""}</article>
    ${manage ? `<form class="settings section-stack" data-create-share><h3>Create a share</h3><label>Share type<select name="mode" aria-label="Share type"><option value="private">Private TCP</option>${data.publicEnabled ? '<option value="public">Public HTTPS</option>' : ""}</select></label><label>Local application port<input type="number" name="port" min="1" max="65535" value="8080" required></label><p class="hint">For public HTTPS, run an HTTP application on the selected local port. Add authentication in your application before publishing sensitive information.</p>${!data.publicEnabled ? '<p class="hint">The provider has disabled public sharing.</p>' : ""}<button class="btn primary" ${data.enabled && data.agent?.state === "ready" ? "" : "disabled"}>Create share</button></form>` : ""}
    <div class="table-wrap"><table class="table private-access-table"><thead><tr><th>Share</th><th>Address</th><th>Status</th><th>Actions</th></tr></thead><tbody>${data.shares.map((s) => `<tr><td>${s.mode === "public" ? "Public HTTPS" : "Private TCP"}<p class="small mono">127.0.0.1:${s.port}</p></td><td class="selectable">${s.mode === "public" ? s.endpoints.map((url) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`).join("<br>") || "Pending" : '<span class="muted">Authorized clients only</span>'}</td><td>${esc(s.state)}${s.error ? `<p class="small">${esc(s.error)}</p>` : ""}</td><td><div class="row">${s.mode === "private" ? `<button class="btn" data-connect-share="${s.id}" ${s.state === "active" && data.enabled ? "" : "disabled"}>Connect privately</button>` : ""}${manage ? `${s.enabled && s.state === "error" ? `<button class="btn" data-toggle-share="${s.id}" data-enable="false">Disable</button>` : ""}<button class="btn" data-toggle-share="${s.id}" data-enable="${!s.enabled || s.state === "error"}" ${s.state === "revoking" ? "disabled" : ""}>${s.state === "error" ? "Retry" : s.enabled ? "Disable" : "Enable"}</button><button class="btn danger" data-delete-share="${s.id}">Delete</button>` : ""}</div></td></tr>`).join("")}</tbody></table></div>
    ${data.shares.length ? "" : '<p class="muted">No application shares on this VM.</p>'}
    <div class="security-card section-stack" data-share-credentials hidden></div>`;
  const reload = () => renderSharing(host, { vmid, manage, current });
  async function run(button, path, method = "POST", body = {}) {
    button.disabled = true;
    const label = button.innerHTML;
    button.innerHTML = loading("Working…");
    try {
      const r = await api(path, {
        method,
        ...(method === "DELETE" ? {} : { body }),
      });
      if (current()) await reload();
      return r;
    } catch (e) {
      if (current()) fail(e);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.innerHTML = label;
      }
    }
  }
  const install = host.querySelector("[data-install-agent]");
  if (install)
    install.onclick = () => run(install, `/api/vms/${vmid}/sharing/agent`);
  const remove = host.querySelector("[data-remove-agent]");
  if (remove)
    remove.onclick = async () => {
      if (
        await confirmAction(
          "Revoke this VM’s zrok identity and remove every application share? The guest service will retain an unusable certificate until removed inside the VM.",
          "Remove sharing agent",
        )
      )
        await run(remove, `/api/vms/${vmid}/sharing/agent`, "DELETE");
    };
  const form = host.querySelector("[data-create-share]");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const isPublic = form.mode.value === "public";
      if (
        isPublic &&
        !(await confirmAction(
          "Publish this HTTP application to the public internet? Anyone with the link can reach it. Application authentication is your responsibility.",
          "Publish application",
        ))
      )
        return;
      await run(e.submitter, `/api/vms/${vmid}/sharing`, "POST", {
        mode: form.mode.value,
        port: Number(form.port.value),
        confirmPublic: isPublic,
      });
    };
  host.querySelectorAll("[data-toggle-share]").forEach(
    (b) =>
      (b.onclick = async () => {
        const on = b.dataset.enable === "true";
        if (
          await confirmAction(
            on
              ? "Enable this application share again? Public shares will become reachable from the internet."
              : "Disable this share? Existing access will be revoked.",
            "Change sharing",
          )
        )
          await run(b, `/api/sharing/${b.dataset.toggleShare}`, "PUT", {
            enabled: on,
          });
      }),
  );
  host.querySelectorAll("[data-delete-share]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          await confirmAction(
            "Delete this application share and revoke its access?",
            "Delete share",
          )
        )
          await run(b, `/api/sharing/${b.dataset.deleteShare}`, "DELETE");
      }),
  );
  host.querySelectorAll("[data-connect-share]").forEach(
    (b) =>
      (b.onclick = async () => {
        const r = await run(b, `/api/sharing/${b.dataset.connectShare}/access`);
        if (!r || !current()) return;
        const box = host.querySelector("[data-share-credentials]");
        box.hidden = false;
        box.innerHTML = `<h3>Connect from your device</h3><p>Install zrok 2. Enable a client environment with your personal token, then connect to this private share.</p><p class="hint">Keep the enable token private. It belongs only to your account in this customer. Use a separate zrok environment if your device is already enabled elsewhere.</p><pre class="mono selectable">export ZROK2_API_ENDPOINT=${esc(r.endpoint)}\nzrok2 enable ${esc(r.enableToken)}\nzrok2 access private ${esc(r.shareToken)} --bind 127.0.0.1:9191</pre><p>Connect your application to 127.0.0.1:9191 while this client runs.</p><button class="btn" data-hide-token>Hide credentials</button>`;
        box.querySelector("[data-hide-token]").onclick = () => {
          box.replaceChildren();
          box.hidden = true;
          toast("Credentials hidden");
        };
      }),
  );
}
