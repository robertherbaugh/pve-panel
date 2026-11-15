import { loading } from '/shared/ui.js';

// Shared controls for every admin inventory, including tables loaded in dialogs.
// Local rows are moved/hidden, never recreated, so editing and action identity survive.
const preferences = new Map();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
let sequence = 0;
const element = (tag, text, attrs = {}) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};
function cellValue(cell) {
  const copy = cell.cloneNode(true);
  const originals = [...cell.querySelectorAll('input,select,textarea')];
  copy.querySelectorAll('input,select,textarea').forEach((input, i) => {
    const original = originals[i];
    input.replaceWith(document.createTextNode(original.tagName === 'SELECT'
      ? [...original.selectedOptions].map(o => o.textContent).join(' ')
      : original.type === 'checkbox' ? (original.checked ? 'Enabled' : 'Disabled') : original.value));
  });
  copy.querySelectorAll('button,[aria-hidden=true]').forEach(n => n.remove());
  return copy.textContent.replace(/\s+/g, ' ').trim();
}
const compare = (a, b) => a !== '' && b !== '' && Number.isFinite(Number(a)) && Number.isFinite(Number(b))
  ? Number(a) - Number(b) : collator.compare(a, b);

export function installAdminTables(scope, { api }) {
  const controllers = new Map();
  function discover() {
    for (const [table, controller] of controllers) if (!table.isConnected) { controller.destroy(); controllers.delete(table); }
    scope.querySelectorAll('table[data-admin-table]').forEach(table => {
      if (!controllers.has(table)) controllers.set(table, enhance(table, api));
      else controllers.get(table).sync();
    });
  }
  const observer = new MutationObserver(discover);
  observer.observe(scope, { childList: true, subtree: true });
  discover();
  return () => { observer.disconnect(); controllers.forEach(c => c.destroy()); controllers.clear(); preferences.clear(); };
}

function enhance(table, api) {
  const key = table.dataset.adminTable;
  const remote = table.adminRemote;
  const preferenceKey = `${key}:${table.dataset.tableInstance ?? ''}`;
  const state = preferences.get(preferenceKey) ?? { q: '', filters: {}, sort: table.dataset.defaultSort ?? '', order: table.dataset.defaultOrder ?? 'asc', page: 1, pageSize: 25 };
  preferences.set(preferenceKey, state);
  const uid = `admin-table-${++sequence}`;
  table.id ||= uid;
  table.setAttribute('aria-label', key);
  const body = table.tBodies[0];
  let synced = false;
  let rows = [], total = 0, pages = 1, revision = 0, timer, destroyed = false, pending = false, ready = !remote;
  const columns = [...table.tHead.rows[0].cells].map((th, i) => ({
    th, i, label: th.textContent.trim(), key: th.dataset.key ?? String(i),
  })).filter(c => !/^(Actions|Save|Remove)$/i.test(c.label) && c.th.dataset.sortable !== 'false');
  const toolbar = element('div', null, { class: 'admin-table-toolbar', role: 'group', 'aria-label': `${key} table controls` });
  const searchLabel = element('label', 'Search');
  const search = element('input', null, { type: 'search', maxlength: '200', placeholder: `Search ${key.toLowerCase()}`, 'aria-label': `Search ${key}`, 'aria-controls': table.id });
  search.value = state.q; searchLabel.append(search);
  const sizeLabel = element('label', 'Rows per page');
  const size = element('select', null, { 'aria-label': `${key} rows per page`, 'aria-controls': table.id });
  for (const value of [10, 25, 50, 100]) size.append(element('option', value, { value }));
  size.value = state.pageSize; sizeLabel.append(size);
  const filterToggle = element('button', 'Filters', { type: 'button', class: 'btn', 'aria-expanded': 'false', 'aria-controls': `${uid}-filters` });
  const clear = element('button', 'Clear filters', { type: 'button', class: 'btn ghost' });
  toolbar.append(searchLabel, sizeLabel, filterToggle, clear);
  const filters = element('div', null, { class: 'admin-table-filters', id: `${uid}-filters`, role: 'group', 'aria-label': `${key} column filters` });
  filters.hidden = true;
  for (const c of columns) {
    const label = element('label', c.label);
    const input = element('input', null, { type: 'search', maxlength: '200', 'aria-label': `Filter ${key} by ${c.label}` });
    input.value = state.filters[c.key] ?? '';
    input.oninput = () => { state.filters[c.key] = input.value; change(true); };
    label.append(input); filters.append(label);
    const sort = element('button', c.label, { type: 'button', class: 'admin-table-sort', 'aria-label': `Sort ${key} by ${c.label}` });
    const arrow = element('span', ' ↕', { 'aria-hidden': 'true' }); sort.append(arrow);
    c.th.replaceChildren(sort); c.sortArrow = arrow;
    sort.onclick = () => {
      state.order = state.sort === c.key && state.order === 'asc' ? 'desc' : 'asc'; state.sort = c.key;
      change();
    };
  }
  const footer = element('div', null, { class: 'admin-table-footer' });
  const status = element('span', '', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
  const navigation = element('div', null, { class: 'admin-table-pages', role: 'group', 'aria-label': `${key} pagination` });
  const buttons = [];
  for (const [label, go] of [['First', () => 1], ['Previous', () => state.page - 1], ['Next', () => state.page + 1], ['Last', () => pages]]) {
    const b = element('button', label, { type: 'button', class: 'btn', 'aria-label': `${key} ${label.toLowerCase()} page` });
    b.onclick = () => { state.page = Math.max(1, Math.min(pages, go())); update(); }; buttons.push(b);
  }
  const pageLabel = element('label', 'Page');
  const page = element('input', null, { type: 'number', min: 1, value: state.page, 'aria-label': `${key} page`, class: 'admin-table-page' });
  const pageCount = element('span', 'of 1');
  page.onchange = () => { state.page = Math.max(1, Math.min(pages, Math.floor(Number(page.value)) || 1)); update(); };
  pageLabel.append(page, pageCount);
  navigation.append(buttons[0], buttons[1], pageLabel, buttons[2], buttons[3]); footer.append(status, navigation);
  const wrap = table.closest('.table-wrap') ?? table;
  wrap.before(toolbar, filters); wrap.after(footer);
  const empty = element('tr', null, { 'data-table-empty': '' });
  empty.append(element('td', 'No matching results.', { colspan: table.tHead.rows[0].cells.length, class: 'muted' }));
  function controls() {
    page.value = state.page; page.max = pages; pageCount.textContent = `of ${pages}`;
    buttons.forEach((b, i) => { b.disabled = pending || (i < 2 ? state.page <= 1 : state.page >= pages); });
    page.disabled = pending;
    columns.forEach(c => {
      c.th.setAttribute('aria-sort', state.sort === c.key ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none');
      c.sortArrow.textContent = state.sort === c.key ? (state.order === 'asc' ? ' ↑' : ' ↓') : ' ↕';
    });
    if (pending) status.innerHTML = loading();
    else status.textContent = `${total ? (state.page - 1) * state.pageSize + 1 : 0}–${Math.min(state.page * state.pageSize, total)} of ${total} results`;
    table.setAttribute('aria-busy', String(pending));
  }
  function sync() {
    if (remote) return;
    const current = [...body.rows].filter(r => !r.hasAttribute('data-table-empty'));
    // Ignore notifications caused by this controller's own sort and empty row.
    const known = new Set(rows);
    if (synced && current.length === rows.length && current.every(r => known.has(r))) return;
    synced = true;
    rows = current;
    update();
  }
  function local() {
    const data = rows.filter(r => r.cells.length > 1).map((row, index) => {
      const values = columns.map(c => cellValue(row.cells[c.i]));
      return { row, index, values, sortValues: columns.map((c, i) => row.cells[c.i].dataset.sortValue ?? values[i]) };
    });
    const matches = data.filter(({ values }) => values.join(' ').toLocaleLowerCase().includes(state.q.trim().toLocaleLowerCase())
      && columns.every((c, i) => values[i].toLocaleLowerCase().includes((state.filters[c.key] ?? '').trim().toLocaleLowerCase())));
    const sortIndex = columns.findIndex(c => c.key === state.sort);
    if (sortIndex >= 0) matches.sort((a, b) => compare(a.sortValues[sortIndex], b.sortValues[sortIndex]) * (state.order === 'asc' ? 1 : -1) || a.index - b.index);
    total = matches.length; pages = Math.max(1, Math.ceil(total / state.pageSize)); state.page = Math.min(state.page, pages);
    rows.forEach(r => { r.hidden = true; });
    const visible = matches.slice((state.page - 1) * state.pageSize, state.page * state.pageSize).map(x => x.row);
    // Only reorder when necessary. The observer sees the same row identities.
    const matchedRows = new Set(matches.map(x => x.row));
    const order = [...matchedRows, ...rows.filter(r => !matchedRows.has(r))];
    const current = [...body.rows].filter(r => r !== empty);
    if (current.some((r, i) => r !== order[i])) body.append(...order);
    visible.forEach(r => { r.hidden = false; });
    empty.hidden = !!total; if (!empty.isConnected) body.append(empty);
    controls();
    table.dispatchEvent(new CustomEvent('admin-table-updated'));
  }
  async function update() {
    clearTimeout(timer);
    if (!remote) { local(); return; }
    const request = ++revision;
    pending = true; controls();
    // Hide old rows immediately: their actions belong to the previous query.
    [...body.rows].forEach(r => { r.hidden = true; });
    const params = new URLSearchParams({ paginated: '1', page: state.page, pageSize: state.pageSize, q: state.q, order: state.order });
    if (state.sort) params.set('sort', state.sort);
    for (const [key, value] of Object.entries(state.filters)) if (value.trim()) params.set(`filter_${key}`, value.trim());
    try {
      const result = await api(`${remote.endpoint}?${params}`);
      if (destroyed || request !== revision) return;
      total = result.total; pages = result.pages; state.page = result.page;
      body.innerHTML = result.items.map(remote.row).join('');
      empty.hidden = !!total; empty.firstChild.textContent = 'No matching results.'; body.append(empty); ready = true;
    } catch (err) {
      if (destroyed || request !== revision) return;
      body.replaceChildren(empty); empty.hidden = false; empty.firstChild.textContent = err.message;
      ready = false;
    } finally {
      if (!destroyed && request === revision) { pending = false; controls(); if (!ready) status.textContent = 'Could not load results. Use Refresh to retry.'; }
    }
  }
  function change(debounce = false) {
    state.page = 1; clearTimeout(timer);
    // Invalidate in-flight responses as soon as the query changes.
    if (remote) ++revision;
    if (remote && debounce) timer = setTimeout(update, 200); else update();
  }
  search.oninput = () => { state.q = search.value; change(true); };
  size.onchange = () => { state.pageSize = Number(size.value); change(); };
  filterToggle.onclick = () => { filters.hidden = !filters.hidden; filterToggle.setAttribute('aria-expanded', String(!filters.hidden)); };
  clear.onclick = () => { state.q = ''; state.filters = {}; search.value = ''; filters.querySelectorAll('input').forEach(i => { i.value = ''; }); change(); };
  const refresh = () => update();
  table.addEventListener('admin-table-refresh', refresh);
  const input = event => { if (!remote && !event.target.hasAttribute('data-table-selection')) local(); };
  table.addEventListener('change', input);
  if (remote) update(); else sync();
  return { sync, destroy() { destroyed = true; ++revision; clearTimeout(timer); table.removeEventListener('admin-table-refresh', refresh); table.removeEventListener('change', input); } };
}
