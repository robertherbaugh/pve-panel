// Searchable disclosure with native checkboxes for keyboard access.
let nextId = 0;
export function resourcePicker(host, { label, selected = [], choices = [], esc, onChange = () => {} }) {
  const picked = new Set(selected.map(String));
  const id = `resource-picker-${++nextId}`;
  host.classList.add('access-picker');
  host.innerHTML = `<span id="${id}-label" class="access-picker-label">${esc(label)}</span>
    <button type="button" class="access-picker-trigger" aria-labelledby="${id}-label" aria-expanded="false" aria-controls="${id}-options"><span data-picker-summary></span><span aria-hidden="true">⌄</span></button>
    <div class="access-picker-panel" id="${id}-options" hidden>
      <input type="search" aria-label="Search ${esc(label.toLowerCase())}" placeholder="Search ${esc(label.toLowerCase())}" autocomplete="off">
      <div class="access-picker-options" role="group" aria-labelledby="${id}-label"></div>
      <p class="hint" data-picker-empty hidden>No matching resources.</p>
    </div>`;
  const trigger = host.querySelector('button');
  const panel = host.querySelector('.access-picker-panel');
  const search = host.querySelector('input[type=search]');
  const list = host.querySelector('[role=group]');
  let options = [];
  function close() { panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
  function open() {
    for (const other of host.closest('dialog').querySelectorAll('.access-picker-trigger[aria-expanded=true]')) if (other !== trigger) other.click();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search.focus();
  }
  function filter() {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of list.children) { row.hidden = !row.dataset.search.includes(query); if (!row.hidden) shown++; }
    host.querySelector('[data-picker-empty]').hidden = shown > 0;
  }
  function summary() {
    const names = new Map(options.map((o) => [String(o.value), o.label]));
    const text = [...picked].map((v) => names.get(v) ?? v).join(', ') || 'None selected';
    host.querySelector('[data-picker-summary]').textContent = text;
    trigger.title = text;
  }
  function update(next) {
    const all = new Map(next.map((o) => [String(o.value), o]));
    for (const value of picked) if (!all.has(value)) all.set(value, { value, label: value, detail: 'Unavailable in the current Proxmox inventory', unavailable: true });
    options = [...all.values()];
    list.innerHTML = options.map((o) => `<label class="access-picker-option" data-search="${esc(`${o.label} ${o.detail ?? ''} ${o.value}`.toLowerCase())}">
      <input type="checkbox" value="${esc(o.value)}" ${picked.has(String(o.value)) ? 'checked' : ''} ${o.unavailable && !picked.has(String(o.value)) ? 'disabled' : ''}>
      <span><strong>${esc(o.label)}</strong><small class="${o.unavailable ? 'access-unavailable' : 'muted'}">${esc(o.detail ?? '')}</small></span></label>`).join('');
    summary(); filter();
  }
  trigger.addEventListener('click', () => panel.hidden ? open() : close());
  trigger.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } });
  search.addEventListener('input', filter);
  list.addEventListener('change', (e) => { if (e.target.checked) picked.add(e.target.value); else picked.delete(e.target.value); summary(); onChange([...picked]); });
  const outside = (e) => { if (!host.contains(e.target)) close(); };
  const escape = (e) => { if (e.key === 'Escape' && !panel.hidden) { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); } };
  document.addEventListener('click', outside);
  host.addEventListener('keydown', escape);
  update(choices);
  return { values: () => [...picked], update, destroy() { document.removeEventListener('click', outside); host.removeEventListener('keydown', escape); } };
}
