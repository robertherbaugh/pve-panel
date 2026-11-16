// Section changes retain the original nodes, including unsaved forms and handlers.
const selected = new Map();
const validationHandlers = new WeakMap();
let sequence = 0;
export function sectionTabs(
  host,
  key,
  sections,
  { before = null, selectionKey = key } = {},
) {
  const id = `sections-${++sequence}`;
  const tabs = document.createElement('div');
  tabs.className = 'tabs section-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', key);
  host.insertBefore(tabs, before);
  const panels = [];
  for (const [i, section] of sections.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab';
    button.setAttribute('role', 'tab');
    button.id = `${id}-tab-${i}`;
    button.textContent = section.label;
    button.setAttribute('aria-controls', `${id}-panel-${i}`);
    tabs.append(button);
    const panel = document.createElement('div');
    panel.className = 'section-panel';
    panel.id = `${id}-panel-${i}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.tabIndex = 0;
    for (const node of section.nodes) if (node) panel.append(node);
    panels.push(panel);
    button.onclick = () => choose(i);
  }
  const buttons = [...tabs.children];
  function choose(i, focus = false) {
    selected.set(selectionKey, sections[i].id);
    buttons.forEach((b, j) => {
      b.classList.toggle('active', i === j);
      b.setAttribute('aria-selected', String(i === j));
      b.tabIndex = i === j ? 0 : -1;
      panels[j].hidden = i !== j;
    });
    if (focus) buttons[i].focus();
  }
  tabs.onkeydown = (event) => {
    const index = buttons.indexOf(event.target);
    if (
      index < 0 ||
      !['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)
    )
      return;
    event.preventDefault();
    choose(
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) %
            buttons.length,
      true,
    );
  };
  tabs.after(...panels);
  choose(
    Math.max(
      0,
      sections.findIndex((s) => s.id === selected.get(selectionKey)),
    ),
  );
  // Native form validation must reveal fields in inactive sections.
  const previous = validationHandlers.get(host);
  if (previous) host.removeEventListener('invalid', previous, true);
  const revealInvalid = (event) => {
    const i = panels.findIndex((p) => p.contains(event.target));
    if (i >= 0) choose(i);
  };
  validationHandlers.set(host, revealInvalid);
  host.addEventListener('invalid', revealInvalid, true);
  return {
    select: (id) => {
      const i = sections.findIndex((s) => s.id === id);
      if (i >= 0) choose(i);
    },
  };
}

export function markedSections(host, key) {
  const nodes = [...host.children].filter((n) =>
    n.hasAttribute('data-section'),
  );
  if (!nodes.length) return;
  return sectionTabs(
    host,
    key,
    nodes.map((node) => ({
      id: node.dataset.section,
      label: node.dataset.section,
      nodes: [node],
    })),
    { before: nodes[0] },
  );
}
