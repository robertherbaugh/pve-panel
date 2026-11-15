import { applyBrand, brandMark, osIcon } from '../shared/icons.js';

const SLOTS = [
  { id: 'logo', label: 'Logo', detail: 'Both portals, sign-in pages and browser tabs.' },
  { id: 'os-windows', label: 'Windows icon', detail: 'Windows servers in the customer portal.' },
  { id: 'os-linux', label: 'Linux icon', detail: 'Linux servers in the customer portal.' },
];
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const readImage = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = reader.onabort = () => reject(new Error('Could not read the image'));
  reader.readAsDataURL(file);
});

export function renderBranding(host, { data, api, esc, toast, fail, confirmAction, onSave }) {
  let state = data, draftName = state.name, status = '', busy = false;
  function render() {
    if (!host.isConnected) return;
    host.innerHTML = `<p class="muted">Set the name and images for both portals. Branding is stored in the panel database and included in database backups.</p>
      <form class="branding-name-form" data-branding-name><label>Panel name<input name="panelName" maxlength="40" required value="${esc(draftName)}"></label><button class="btn primary">Save name</button></form>
      <p class="hint">PNG, JPEG, WebP or SVG, up to 1 MiB per image. Uploads apply immediately. Remove an image to restore the built-in artwork.</p>
      <div class="branding-assets">${SLOTS.map((slot) => {
        const asset = state.assets[slot.id];
        return `<section class="branding-asset" data-branding-slot="${slot.id}"><div class="branding-preview">${asset ? `<img src="${esc(asset.url)}" alt="${slot.label} preview">` : slot.id === 'logo' ? brandMark(48) : osIcon(slot.id.slice(3), 48)}</div>
          <h3>${slot.label}</h3><p class="muted small">${slot.detail}</p>
          <label class="branding-upload">Upload ${slot.label.toLowerCase()}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-upload="${slot.id}"></label>
          ${asset ? `<button type="button" class="btn danger" data-remove="${slot.id}">Remove ${slot.label.toLowerCase()}</button>` : '<p class="muted small">Using built-in artwork</p>'}</section>`;
      }).join('')}</div><p role="status" class="muted small" data-branding-status>${esc(status)}</p><p role="alert" class="form-error" data-branding-error></p>`;
    const form = host.querySelector('form');
    form.elements.panelName.oninput = () => { draftName = form.elements.panelName.value; };
    form.onsubmit = (e) => {
      e.preventDefault();
      mutate('/api/admin/settings/branding', { method: 'PUT', body: { name: draftName } }, true);
    };
    host.querySelectorAll('[data-upload]').forEach((input) => {
      input.onchange = async () => {
        const file = input.files[0];
        if (!file || busy) return;
        try {
          if (file.size > 1024 * 1024 || !file.size) throw new Error('Images must be between 1 byte and 1 MiB');
          const type = file.type || TYPES[file.name.split('.').pop().toLowerCase()];
          if (!Object.values(TYPES).includes(type)) throw new Error('Use a PNG, JPEG, WebP or SVG image');
          setBusy(true);
          const image = await readImage(file);
          await mutate(`/api/admin/settings/branding/${input.dataset.upload}`, { method: 'PUT', body: { type, data: image } });
        } catch (err) { report(err); } finally { setBusy(false); input.value = ''; }
      };
    });
    host.querySelectorAll('[data-remove]').forEach((button) => {
      button.onclick = async () => {
        if (busy || !await confirmAction('Remove this image and restore the built-in artwork?', 'Remove image')) return;
        await mutate(`/api/admin/settings/branding/${button.dataset.remove}`, { method: 'DELETE' });
      };
    });
  }
  function setBusy(value) {
    busy = value;
    host.querySelectorAll('input,button').forEach((el) => { el.disabled = value; });
  }
  function report(err) {
    if (host.isConnected) host.querySelector('[data-branding-error]').textContent = err.message;
    fail(err);
  }
  async function mutate(path, options, saveName = false) {
    setBusy(true);
    try {
      state = await api(path, { ...options, headers: { 'If-Match': state.revision } });
      if (saveName) draftName = state.name;
      status = 'Branding saved';
      onSave(state);
      await applyBrand('Administration');
      render();
      toast(status);
    } catch (err) { report(err); } finally { setBusy(false); }
  }
  render();
}
