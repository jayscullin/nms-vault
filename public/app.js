// NMS Vault UI. All edits go through the server, which validates each one;
// the page only renders the server's view of the working copy.

import { icon, GROUP_ICONS } from './icons.js';
import { showModel } from './viewer.js';

const groupIcon = (group, size = 14) => (GROUP_ICONS[group] ? icon(GROUP_ICONS[group], size) : '');

const TOKEN = document.querySelector('meta[name=vault-token]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const state = {
  accounts: [],
  gamedata: null,
  verify: {},
  view: null, // session view from the server
  selected: null, // container id, or 'items'
  slot: null, // { inv, x, y }
  search: '',
  highlight: null, // item id to outline
  saveMenu: null, // account/file whose Open menu is showing
  rewardsMenu: false, // the top bar's platform chooser
  detailsOverlayOpen: false, // the details drawer, when it floats over the content at small widths
};

// Details pane: below this width it starts collapsed and opens over the content.
const narrow = matchMedia('(max-width: 1100px)');
const DETAILS_PREF = 'nmsVault.detailsCollapsed';
const pref = {
  get: () => { try { return localStorage.getItem(DETAILS_PREF) === '1'; } catch { return false; } },
  set: (v) => { try { localStorage.setItem(DETAILS_PREF, v ? '1' : '0'); } catch {} },
};
const detailsOpen = () => (narrow.matches ? state.detailsOverlayOpen : !pref.get());
function toggleDetails(open = !detailsOpen()) {
  if (narrow.matches) state.detailsOverlayOpen = open;
  else pref.set(!open);
  render();
}
narrow.addEventListener('change', () => {
  state.detailsOverlayOpen = false; // auto-collapse when the window gets small
  if (state.view) render();
});

const CURRENCY_LABELS = { Units: 'Units', Nanites: 'Nanites', Specials: 'Quicksilver' };
const BULK = new Set(['general', 'storage']); // kinds that can receive items; matches src/inventory.js

// ---- helpers ---------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString();

// Fallback when the game data has no entry: "^LAND1" -> "Land 1".
function idName(id) {
  const [base, seed] = String(id).replace(/^\^/, '').split('#');
  const words = base.replace(/_/g, ' ').toLowerCase().replace(/(\D)(\d+)$/, '$1 $2');
  const nice = words.replace(/\b\w/g, (c) => c.toUpperCase());
  return seed ? `${nice} #${seed}` : nice;
}
const info = (id) => state.view?.items?.[id] ?? null;
const itemName = (id) => info(id)?.name ?? idName(id);
const iconUrl = (id) => (info(id)?.icon ? `/icons/${encodeURIComponent(info(id).key)}.png` : null);
const matches = (id, q) => id.toLowerCase().includes(q) || itemName(id).toLowerCase().includes(q);
const monogram = (id) => String(id).replace(/^\^/, '').replace(/^UP_/, '').replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase();

async function api(path, body) {
  const busy = $('#busy');
  busy.hidden = false;
  try {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Vault-Token': TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  } finally {
    busy.hidden = true;
  }
}

function toast(message, error = false) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), error ? 6000 : 3000);
}

async function run(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  }
}

const allInventories = () => (state.view?.containers ?? []).flatMap((c) => c.inventories.map((i) => ({ ...i, container: c })));
const findInv = (id) => allInventories().find((i) => i.id === id);
const slotAt = (inv, x, y) => inv?.slots.find((s) => s.x === x && s.y === y);

// ---- edits -----------------------------------------------------------------

async function applyOp(op) {
  await run(async () => {
    const before = state.view.warnings.length;
    state.view = await api('/api/op', { sessionId: state.view.sessionId, op });
    for (const w of state.view.warnings.slice(before)) toast(w);
    if (state.slot && !slotAt(findInv(state.slot.inv), state.slot.x, state.slot.y)) state.slot = null;
    render();
  });
}

function firstFreeCell(inv) {
  const used = new Set(inv.slots.map((s) => `${s.x},${s.y}`));
  const free = inv.valid.find((k) => !used.has(k));
  return free && free.split(',').map(Number);
}

function moveToContainer(from, containerId) {
  const c = state.view.containers.find((x) => x.id === containerId);
  const fromInv = findInv(from.inv);
  const item = slotAt(fromInv, from.x, from.y);
  // Prefer topping up an existing stack, then the first free cell.
  const targets = c.inventories.filter((i) => i.id !== from.inv && dropBlock(item, from.inv, { ...i, container: c }) === null);
  if (!targets.length) return toast(containerBlock(item, from.inv, c) ?? `${c.title} can’t take that`, true);
  for (const inv of targets) {
    const stack = inv.slots.find((s) => s.id === item.id && s.amount < s.max);
    if (stack) return applyOp({ op: 'move', from, to: { inv: inv.id, x: stack.x, y: stack.y } });
  }
  for (const inv of targets) {
    const cell = firstFreeCell(inv);
    if (cell) return applyOp({ op: 'move', from, to: { inv: inv.id, x: cell[0], y: cell[1] } });
  }
  toast(`No free space in ${c.title}`, true);
}

// ---- views -----------------------------------------------------------------

function renderTopbar() {
  const v = state.view;
  $('#save-info').innerHTML = v
    ? `<b>${esc(v.kind === 'account' ? 'Account rewards' : v.summary || v.file)}</b> · ${esc(v.file)} · ${esc(v.account)}`
    : '<span class="muted">No save open</span>';
  $('#pending').innerHTML = v
    ? `${v.ops ? `<span class="badge" title="Pending changes">${v.ops}</span>` : ''}
       <button class="btn icon-btn" data-action="undo" aria-label="Undo" title="Undo (⌘Z)" ${v.ops ? '' : 'disabled'}>${icon('undo')}</button>
       <button class="btn icon-btn" data-action="reset" aria-label="Reset: discard all changes" title="Reset: discard all changes" ${v.ops ? '' : 'disabled'}>${icon('discard')}</button>
       <button class="btn primary" data-action="review" title="Review and save (⌘S)" ${v.ops ? '' : 'disabled'}>${icon('save', 16)} Save</button>`
    : '';
  // Global tools, on every page.
  $('#global-tools').innerHTML = `${renderRewardsButton()}${state.gamedata?.available
    ? `<button class="btn with-icon all-items-btn" data-action="catalogue" title="Browse every item in the game">${icon('shapes')}All Items</button>`
    : ''}`;
}

// Rewards live in each platform's own account file. With a save or rewards open that
// is its platform; on the save page, several platforms get a menu to choose from.
function rewardAccounts() {
  const open = state.view?.account;
  return state.accounts.filter((a) => a.accountFile && (!open || a.id === open));
}

function renderRewardsButton() {
  const accounts = rewardAccounts();
  if (!accounts.length) return '';
  const showing = state.view?.kind === 'account';
  if (accounts.length === 1) {
    const [a] = accounts;
    const label = `Rewards for ${a.kind} account ${a.id}`;
    return `<button class="btn with-icon ${showing ? 'active' : ''}" data-action="open-rewards" data-account="${esc(a.id)}" data-file="accountdata.hg" title="${esc(label)}" aria-label="${esc(label)}" ${showing ? 'aria-current="page"' : ''}>${icon('award')}Rewards</button>`;
  }
  return `<div class="split-btn">
    <button class="btn with-icon" data-action="rewards-menu" aria-haspopup="menu" aria-expanded="${state.rewardsMenu}" title="Choose a platform">${icon('award')}Rewards${icon('chevron', 14)}</button>
    ${state.rewardsMenu ? `<div class="save-menu" role="menu">${accounts
      .map((a) => `<button class="menu-item" role="menuitem" data-action="open-rewards" data-account="${esc(a.id)}" data-file="accountdata.hg"><span><b>${esc(a.kind)}</b> <span class="mono muted">${esc(a.id)}</span></span></button>`)
      .join('')}</div>` : ''}
  </div>`;
}

// ---- save picker -----------------------------------------------------------

const savedAt = (s) => new Date(s.savedAt ?? s.mtime);

function playTime(seconds) {
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${fmt(h)}h ${m}m` : `${m}m`;
}

// The game shows one entry per slot: the newer of the slot's two saves. The older
// one isn't listed (it still counts for duplicate-save detection).
function slotGroups(slots) {
  const groups = new Map();
  for (const s of slots) {
    if (!groups.has(s.slot)) groups.set(s.slot, []);
    groups.get(s.slot).push(s);
  }
  return [...groups].map(([slot, saves]) => ({ slot, saves: saves.sort((x, y) => savedAt(y) - savedAt(x)) }));
}

// Slots whose saves share a save id with another slot: the game treats them as one
// save in two places and shows a "multiple versions of this save" conflict.
function duplicateSlots(slots) {
  const byId = new Map();
  for (const s of slots) {
    if (!s.universalId) continue;
    if (!byId.has(s.universalId)) byId.set(s.universalId, new Set());
    byId.get(s.universalId).add(s.slot);
  }
  const dup = new Map();
  for (const set of byId.values()) if (set.size > 1) for (const n of set) dup.set(n, [...set].filter((m) => m !== n));
  return dup;
}

function renderSlotGroup(a, { slot, saves }) {
  const latest = saves[0];
  const title = latest.name || `Save slot ${slot}`;
  const tags = [latest.difficulty, latest.season ? 'Expedition' : null].filter(Boolean);
  const sameAs = duplicateSlots(a.slots).get(slot);
  return `
    <div class="slot-group">
      <div class="slot-head">
        <div class="slot-num">${slot}</div>
        <div class="slot-title">
          <b>${esc(title)}</b>${tags.map((t) => `<span class="tag" ${t === 'Expedition' ? `title="Season ${latest.season}"` : ''}>${esc(t)}</span>`).join('')}
          <div class="muted">${playTime(latest.playTime) ? `${playTime(latest.playTime)} played · ` : ''}last saved ${savedAt(latest).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</div>
        </div>
      </div>
      ${sameAs ? `<div class="warnings slot-warning">Same save as slot ${sameAs.join(', ')}. The game will report a cross-save conflict. Restore the slot that was overwritten from Backups, or delete one copy from the game’s own load menu.</div>` : ''}
      ${renderSaveRow(a, latest)}
    </div>`;
}

function renderSaveRow(a, s) {
  const vr = state.verify[`${a.id}/${s.file}`];
  const menuOpen = state.saveMenu === `${a.id}/${s.file}`;
  return `
    <div class="slot-row">
      <div>${esc(s.summary ?? s.error ?? 'Unknown location')}
        <div class="when">${savedAt(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}${playTime(s.playTime) ? ` · ${playTime(s.playTime)}` : ''} · <span class="mono">${esc(s.file)}</span></div></div>
      <div class="split-btn">
        <button class="btn primary" data-action="open" data-account="${esc(a.id)}" data-file="${esc(s.file)}">Open</button>
        <button class="btn primary split-toggle" data-action="save-menu" data-account="${esc(a.id)}" data-file="${esc(s.file)}" aria-haspopup="menu" aria-expanded="${menuOpen}" aria-label="More actions for ${esc(s.file)}">${icon('chevron', 16)}</button>
        ${menuOpen ? `<div class="save-menu" role="menu">
          <button class="menu-item" role="menuitem" data-action="export-json" data-account="${esc(a.id)}" data-file="${esc(s.file)}">${icon('export', 15)}Export as JSON</button>
          <button class="menu-item" role="menuitem" data-action="slot-menu" data-account="${esc(a.id)}" data-file="${esc(s.file)}">${icon('copy', 15)}Copy…</button>
          <button class="menu-item" role="menuitem" data-action="verify" data-account="${esc(a.id)}" data-file="${esc(s.file)}" title="Prove the save can be rewritten without changing a byte">${icon('verify', 15)}Verify</button>
          <hr>
          <button class="menu-item danger" role="menuitem" data-action="slot-op" data-op="delete" data-account="${esc(a.id)}" data-file="${esc(s.file)}">${icon('trash', 15)}Delete</button>
        </div>` : ''}
      </div>
      ${vr ? `<div class="verify-result">${vr.checks.map((c) => `<span style="color:var(--${c.ok ? 'ok' : 'bad'})">${c.ok ? '✓' : '✗'} ${esc(c.name)}${c.detail ? ` <span class="muted">— ${esc(c.detail)}</span>` : ''}</span>`).join('')}</div>` : ''}
    </div>`;
}

function renderHome() {
  const accounts = state.accounts;
  app.innerHTML = `
    <section class="home">
      <h1>Choose a save</h1>
      <p class="lead">Edits are staged in memory and validated. Nothing touches your save until you review and confirm, and every write is backed up first.</p>
      ${state.where ? `<p class="gamedata">Save folder: <span class="mono">${esc(state.where.saveRoots.join(', '))}</span></p>` : ''}
      ${state.gamedata ? `<p class="gamedata ${state.gamedata.available ? '' : 'warn'}">${state.gamedata.available ? `Item names and icons: ${fmt(state.gamedata.items)} items read from your game install.` : `Item names unavailable — ${esc(state.gamedata.reason)}`}</p>` : ''}
      ${accounts.length ? '' : '<div class="empty-state">No No Man’s Sky saves were found. Set <span class="mono">NMS_SAVE_ROOT</span> to your <span class="mono">HelloGames/NMS</span> folder and restart.</div>'}
      ${accounts
        .map(
          (a) => `
        <div class="account">
          <header><div><b>${esc(a.kind)}</b> <span class="muted mono">${esc(a.id)}</span></div>
            <div class="stack-row">
              <button class="btn small with-icon" data-action="backups" data-account="${esc(a.id)}">${icon('backups', 14)}Backups</button>
            </div></header>
          ${slotGroups(a.slots).map((g) => renderSlotGroup(a, g)).join('')}
        </div>`,
        )
        .join('')}
    </section>`;
}

function renderSidebar() {
  const groups = new Map();
  for (const c of state.view.containers) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  const count = (c) => c.inventories.reduce((n, i) => n + i.slots.length, 0);
  return `
    <nav class="sidebar">
      <div class="search"><input type="search" id="search" placeholder="Find items…" value="${esc(state.search)}" aria-label="Find items"></div>
      <div class="nav-group">
        <button class="nav-item ${state.selected === 'items' ? 'active' : ''}" data-select="items"><span class="with-icon">${icon('inventory', 14)}Inventory</span></button>
        <button class="nav-item ${state.selected === 'words' ? 'active' : ''}" data-select="words"><span class="with-icon">${icon('words', 14)}Words</span></button>
        <button class="nav-item ${state.selected === 'blueprints' ? 'active' : ''}" data-select="blueprints"><span class="with-icon">${icon('blueprints', 14)}Blueprints</span></button>
      </div>
      ${[...groups]
        .map(
          ([group, list]) => `
      <div class="nav-group">
        <button class="group-title ${state.selected === `group:${group}` ? 'active' : ''}" data-select="group:${esc(group)}" title="Show all ${esc(group)} together"><span class="with-icon">${groupIcon(group)}${esc(group)}</span> <span class="count">${list.length > 1 ? `all ${list.length}` : ''}</span></button>
        ${list
          .map(
            (c) => `
          <button class="nav-item ${state.selected === c.id ? 'active' : ''}" data-select="${c.id}" data-drop-container="${c.inventories.some((i) => BULK.has(i.kind)) ? c.id : ''}">
            <span>${esc(c.title)}${c.current ? '<span class="current" title="Currently in use">●</span>' : ''}${c.subtitle && c.subtitle !== c.title ? `<span class="sub">${esc(c.subtitle)}</span>` : ''}</span>
            <span class="count">${count(c) || ''}</span>
          </button>`,
          )
          .join('')}
      </div>`,
        )
        .join('')}
    </nav>`;
}

// Matches src/inventory.js: storage and base inventories are capped by the game.
const canUnlockSlots = (inv) => inv.kind === 'general' || inv.kind === 'tech';

function renderGrid(inv) {
  const valid = new Set(inv.valid);
  const canUnlock = canUnlockSlots(inv);
  const q = state.search.trim().toLowerCase();
  const cells = [];
  for (let y = 0; y < inv.height; y++) {
    for (let x = 0; x < inv.width; x++) {
      const s = slotAt(inv, x, y);
      const unlocked = valid.has(`${x},${y}`);
      const sel = state.slot && state.slot.inv === inv.id && state.slot.x === x && state.slot.y === y;
      const hit = s && ((q && matches(s.id, q)) || state.highlight === s.id);
      const icon = s && iconUrl(s.id);
      cells.push(`
        <div class="cell ${unlocked ? '' : `locked${canUnlock ? ' unlockable' : ''}`} ${sel ? 'selected' : ''} ${hit ? 'hit' : ''}" data-cell data-inv="${esc(inv.id)}" data-x="${x}" data-y="${y}"${unlocked || s ? '' : ` title="${canUnlock ? 'Locked slot: click to unlock it' : 'Locked slot: this inventory’s size is capped by the game'}"`}>
          ${
            s
              ? `<button class="tile t-${esc(s.type)}${icon ? ' has-icon' : ''}${s.type === 'Technology' && s.damage > 0 ? ' damaged' : ''}" draggable="true" data-slot aria-label="${esc(itemName(s.id))} (${esc(s.id)})">
                  ${icon ? `<img src="${icon}" alt="" loading="lazy" draggable="false">` : `<span class="mono-tag">${esc(monogram(s.id))}</span><span class="name">${esc(itemName(s.id))}</span>`}
                  ${s.type === 'Technology' ? '' : `<span><span class="amt">${fmt(s.amount)}/${fmt(s.max)}</span><span class="bar"><i style="width:${Math.min(100, (s.amount / Math.max(1, s.max)) * 100)}%"></i></span></span>`}
                </button>`
              : ''
          }
        </div>`);
    }
  }
  return `<div class="grid" style="--cols: ${inv.width}">${cells.join('')}</div>`;
}

// 3D preview of a ship, multi-tool or freighter. Shown disabled, with the reason, when the model can't be previewed.
const modelButton = (c) =>
  c.model
    ? c.model.available
      ? `<button class="btn small with-icon" data-action="model" data-container="${esc(c.id)}" title="View this model in 3D">${icon('model', 14)}3D</button>`
      : `<button class="btn small with-icon" disabled title="${esc(c.model.reason)}" aria-label="3D view unavailable: ${esc(c.model.reason)}">${icon('model', 14)}3D</button>`
    : '';

// Change type and delete, for ships and the freighter. Disabled with the reason where the edit isn't safe.
function manageButtons(c) {
  if (!c.manage) return '';
  const lock = c.manage.lock;
  const off = (why) => (why ? `disabled title="${esc(why)}" aria-label="Unavailable: ${esc(why)}"` : '');
  const type = `<button class="btn small with-icon" data-action="change-type" data-container="${esc(c.id)}" ${lock ? off(lock) : 'title="Change which type of ship this is"'}>${icon('type', 14)}Type</button>`;
  if (c.freighter) return type;
  const why = lock ?? (c.current ? 'This is the ship in use. Switch to another ship in game before deleting it.' : '');
  return `${type}<button class="btn small danger with-icon" data-action="delete-ship" data-container="${esc(c.id)}" ${why ? off(why) : 'title="Delete this ship"'}>${icon('trash', 14)}Delete</button>`;
}

function openTypeChange(id) {
  const c = state.view.containers.find((x) => x.id === id);
  modal(`
    <h2 class="with-icon">${icon('type', 20)}Change type</h2>
    <p class="muted">${esc(c.title)} keeps its seed, inventory and technology, and the game rebuilds its look from the seed.${c.freighter ? '' : ' Any appearance customisation is cleared, because those parts belong to the old type.'}</p>
    <div class="type-picker">
      <div class="add-targets">${c.manage.kinds
        .map((k) => {
          const now = k.scene === c.model?.scene;
          return `<label class="add-target"><input type="radio" name="kind" value="${esc(k.scene)}" data-current="${now ? 1 : ''}" ${now ? 'checked' : ''}><span>${esc(k.label)}${now ? '<small class="muted">current</small>' : ''}</span></label>`;
        })
        .join('')}</div>
      <figure class="type-preview">
        <div class="model-stage"><div class="model-status muted">Loading…</div></div>
        <figcaption class="muted small" id="type-caption"></figcaption>
      </figure>
    </div>
    <footer><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" data-action="type-confirm" data-container="${esc(c.id)}">Change type</button></footer>`, { wide: true });
  previewType();
}

// Shows an example of the chosen type. Each one gets a fresh canvas, since releasing a
// model gives up its canvas; a slower earlier load is dropped when it finally arrives.
let previewToken = 0;
async function previewType() {
  const radio = $('#modal-root input[name="kind"]:checked');
  const stage = $('#modal-root .type-preview .model-stage');
  if (!radio || !stage) return;
  const token = ++previewToken;
  releaseModal?.();
  releaseModal = null;
  stage.innerHTML = '<canvas aria-hidden="true"></canvas><div class="model-status muted">Loading…</div>';
  const label = radio.closest('label').querySelector('span').firstChild.textContent;
  $('#type-caption').textContent = `An example ${label}, not this exact ship: the real parts and colours come from its seed in game.`;
  try {
    const { release } = await showModel(stage.querySelector('canvas'), radio.value, [], { example: true });
    if (token !== previewToken || !stage.isConnected) return release();
    releaseModal = release;
    stage.querySelector('.model-status').remove();
    stage.querySelector('canvas').classList.add('ready');
  } catch (e) {
    if (token === previewToken && stage.isConnected) stage.querySelector('.model-status').textContent = e.message;
  }
}

const renameButton = (c) => (c.nameKey ? `<button class="btn small" data-action="rename" data-name-key="${esc(c.nameKey)}" data-name="${esc(c.name ?? '')}">Rename</button>` : '');

function renderInventories(c) {
  return c.inventories
    .map(
      (inv) => `
      <section class="inv" data-inv-section="${esc(inv.id)}">
        <h3>${esc(inv.label)} <span class="muted">${inv.slots.length}/${inv.valid.length} used · ${inv.width}×${inv.height}${inv.stackGroup ? ` · ${esc(inv.stackGroup)} stacks` : ''}</span>${sortTools(inv)}</h3>
        ${renderGrid(inv)}
      </section>`,
    )
    .join('');
}

function renderContainer(c) {
  return `
    <h2>${esc(c.title)} ${renameButton(c)} ${modelButton(c)} ${manageButtons(c)}</h2>
    <p class="sub">${esc(c.group)}${c.subtitle ? ` · ${esc(c.subtitle)}` : ''}${c.current ? ' · in use' : ''}</p>
    ${renderInventories(c)}`;
}

// Every member of a sidebar group on one page, so items can be dragged between them.
function renderGroup(group) {
  const members = state.view.containers.filter((c) => c.group === group);
  const techOnly = members.every((c) => c.inventories.every((i) => i.kind === 'tech'));
  return `
    <h2 class="with-icon">${groupIcon(group, 20)}${esc(group)}</h2>
    <p class="sub">${members.length} ${members.length === 1 ? 'entry' : 'entries'}. Drag items between any of them.${techOnly ? ' Technology stays in its own grid, so here you can rearrange each one but not move tech between them.' : ''}</p>
    ${members
      .map(
        (c) => `
      <section class="group-member">
        <h2 class="member-title">${esc(c.title)} ${c.current ? '<span class="current" title="Currently in use">●</span>' : ''}<span class="muted small">${esc(c.subtitle && c.subtitle !== c.title ? c.subtitle : '')}</span> ${renameButton(c)} ${modelButton(c)}
          <button class="btn small" data-select="${esc(c.id)}">Open on its own</button></h2>
        ${renderInventories(c)}
      </section>`,
      )
      .join('')}`;
}

function aggregateItems() {
  const items = new Map();
  for (const inv of allInventories()) {
    for (const s of inv.slots) {
      let it = items.get(s.id);
      if (!it) items.set(s.id, (it = { id: s.id, type: s.type, total: 0, locations: [] }));
      it.total += s.type === 'Technology' ? 1 : s.amount;
      it.locations.push({ inv, slot: s });
    }
  }
  return [...items.values()];
}

// Sort controls for inventories that hold products and substances. The chosen
// order and the combine option are remembered for the session.
state.sortBy = 'type';
state.sortCombine = true;

function sortTools(inv) {
  const locked = inv.width * inv.height - inv.valid.length;
  const unlock = canUnlockSlots(inv) && locked > 0
    ? `<button class="btn small" data-action="unlock-slots" data-inv="${esc(inv.id)}" title="Unlock every locked cell in this grid">Unlock ${locked} slot${locked === 1 ? '' : 's'}</button>`
    : '';
  if (!BULK.has(inv.kind) || inv.slots.filter((s) => s.type !== 'Technology').length < 2) return unlock ? `<span class="inv-tools">${unlock}</span>` : '';
  const opts = [['type', 'Type'], ['name', 'Name'], ['amount', 'Amount']];
  return `
    <span class="inv-tools">
      ${unlock}
      <select data-sort-by aria-label="Sort ${esc(inv.label)} by">${opts.map(([v, l]) => `<option value="${v}" ${v === state.sortBy ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="combine" title="Merge partial stacks of the same item, up to the game's stack limit"><input type="checkbox" data-sort-combine ${state.sortCombine ? 'checked' : ''}> Combine stacks</label>
      <button class="btn small" data-action="sort" data-inv="${esc(inv.id)}">Sort</button>
    </span>`;
}

function renderItems() {
  const q = state.search.trim().toLowerCase();
  const rows = aggregateItems()
    .filter((it) => !q || matches(it.id, q))
    .sort((a, b) => a.type.localeCompare(b.type) || b.total - a.total);
  return `
    <h2 class="with-icon">${icon('inventory', 22)}Inventory</h2>
    <p class="sub">${rows.length} distinct items across every inventory${q ? ` matching “${esc(state.search)}”` : ''}. Click a location to jump to it.</p>
    <table class="items-table">
      <thead><tr><th>Item</th><th>Type</th><th class="num">Total</th><th>Where</th></tr></thead>
      <tbody>${rows
        .map(
          (it) => `
        <tr class="t-${esc(it.type)}">
          <td><div class="item-cell">${iconUrl(it.id) ? `<img class="thumb" src="${iconUrl(it.id)}" alt="" loading="lazy">` : '<span class="thumb dot"></span>'}
            <div>${esc(itemName(it.id))}${info(it.id)?.subtitle ? `<div class="muted small">${esc(info(it.id).subtitle)}</div>` : ''}<div class="mono muted">${esc(it.id)}</div></div></div></td>
          <td>${esc(it.type)}</td>
          <td class="num">${fmt(it.total)}</td>
          <td>${it.locations
            .map((l) => `<button class="loc" data-jump="${esc(l.inv.container.id)}" data-inv="${esc(l.inv.id)}" data-x="${l.slot.x}" data-y="${l.slot.y}">${esc(l.inv.container.title)} · ${esc(l.inv.label)}${it.type === 'Technology' ? '' : ` · ${fmt(l.slot.amount)}`}</button>`)
            .join('')}</td>
        </tr>`,
        )
        .join('')}</tbody>
    </table>`;
}

// The details pane, collapsible to a floating tab. At small widths it opens over the content.
function renderDetails() {
  const open = detailsOpen();
  const label = open ? 'Collapse details' : 'Show details';
  const toggle = `<button class="btn icon-btn details-toggle" data-action="details-toggle" aria-label="${label}" title="${label}" aria-expanded="${open}" aria-controls="details">${icon(open ? 'panel-close' : 'panel-open')}</button>`;
  return `
    ${open && narrow.matches ? '<div class="details-backdrop" data-action="details-toggle"></div>' : ''}
    <aside class="details ${open ? 'open' : 'collapsed'}${narrow.matches ? ' overlay' : ''}" id="details" aria-label="Details">
      ${toggle}${open ? `<div class="details-body">${detailsBody()}</div>` : state.slot ? '<span class="details-dot" aria-hidden="true"></span>' : ''}
    </aside>`;
}

function detailsBody() {
  const inv = state.slot && findInv(state.slot.inv);
  const s = inv && slotAt(inv, state.slot.x, state.slot.y);
  if (inv && !s) {
    const canAdd = BULK.has(inv.kind);
    return `
      <h3>Empty cell</h3>
      <dl><dt>Location</dt><dd>${esc(inv.container.title)} · ${esc(inv.label)}</dd><dt>Cell</dt><dd>${state.slot.x}, ${state.slot.y}</dd></dl>
      ${canAdd
        ? '<div class="stack"><button class="btn primary" data-action="add-item">Add item…</button></div>'
        : `<div class="note">${esc(inv.label)} inventories only hold items the game installs, so new items can’t be added here.</div>`}
    `;
  }
  if (!s) {
    return `<p class="muted">Select an item to edit it, or an empty cell to add one. Drag items between cells, or onto a container in the sidebar to transfer them.</p>
      <div class="note">Technology can be rearranged within its own grid, recharged, repaired, or removed if it isn’t core technology. It can’t be moved to another inventory.</div>
      <div class="note">Press <kbd>?</kbd> for keyboard shortcuts.</div>`;
  }
  const bulk = s.type !== 'Technology';
  const meta = info(s.id);
  return `
    
      ${iconUrl(s.id) ? `<img class="hero t-${esc(s.type)}" src="${iconUrl(s.id)}" alt="">` : ''}
      <h3>${esc(itemName(s.id))}</h3>
      ${meta?.subtitle ? `<div class="muted">${esc(meta.subtitle)}</div>` : ''}
      <div class="mono muted">${esc(s.id)}</div>
      ${meta?.desc ? `<p class="desc">${esc(meta.desc)}</p>` : ''}
      ${meta?.generic ? '<p class="note">The game generates this item’s name from its seed, so only its category is shown.</p>' : ''}
      <dl>
        <dt>Type</dt><dd><span class="t-${esc(s.type)}"><span class="dot"></span></span>${esc(s.type)}</dd>
        <dt>Location</dt><dd>${esc(inv.container.title)} · ${esc(inv.label)}</dd>
        <dt>Cell</dt><dd>${s.x}, ${s.y}</dd>
        ${bulk
          ? `<dt>Amount</dt><dd>${fmt(s.amount)}</dd>
             <dt>Stack limit</dt><dd title="Set by the game for this item in this inventory; never changed by NMS Vault">${fmt(s.max)} <span class="muted">· game</span></dd>`
          : `<dt>Charge</dt><dd>${fmt(s.amount)} / ${fmt(s.max)}</dd>`}
        ${s.damage ? `<dt>Damage</dt><dd>${(s.damage * 100).toFixed(0)}%</dd>` : ''}
      </dl>
      ${
        bulk
          ? `<form class="amount-form" data-form="amount">
              <input name="amount" type="number" min="1" max="${s.max}" step="1" value="${s.amount}" aria-label="Amount">
              <button class="btn" type="submit">Set</button>
            </form>
            <div class="stack">
              <button class="btn" data-action="fill" ${s.amount >= s.max ? 'disabled' : ''}>Fill stack (${fmt(s.max)})</button>
              <button class="btn danger" data-action="remove">Remove item</button>
            </div>`
          : techActions(s, meta)
      }
    `;
}

// Technology buttons, offered only where the game data allows the edit.
function techActions(s, meta) {
  const placeholder = s.damage > 0 && s.installed;
  const buttons = [];
  if (meta?.chargeable && s.amount >= 0 && s.max > 0 && s.damage === 0) {
    buttons.push(`<button class="btn" data-action="recharge" ${s.amount >= s.max ? 'disabled' : ''}>Recharge (${fmt(s.max)})</button>`);
  }
  if (s.damage > 0 && !s.installed) buttons.push('<button class="btn" data-action="repair">Repair</button>');
  if (meta?.core === false) buttons.push(`<button class="btn danger" data-action="remove">${placeholder ? 'Remove broken part' : 'Remove technology'}</button>`);
  const notes = [];
  if (meta?.core === true) notes.push('Core technology: the game doesn’t allow dismantling it, so it can’t be removed.');
  if (meta?.core === undefined) notes.push('Can’t confirm from the game data whether this is core technology, so it can’t be removed.');
  if (placeholder) notes.push('This is a placeholder for a broken slot. The game removes it on repair, so removing it frees the slot.');
  if (meta?.chargeable === false && s.amount >= 0 && !placeholder) notes.push('This technology doesn’t use charge.');
  return `${buttons.length ? `<div class="stack">${buttons.join('')}</div>` : ''}${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}`;
}

// ---- add item ----------------------------------------------------------------

async function openAddItem() {
  const target = { ...state.slot };
  const inv = findInv(target.inv);
  modal(`
    <h2>Add item</h2>
    <p class="muted">To ${esc(inv.container.title)} · ${esc(inv.label)}, cell ${target.x}, ${target.y}. Stack limits come from the game.</p>
    <input type="search" id="add-search" class="add-search" placeholder="Search by name or ID…" autocomplete="off" aria-label="Search items">
    <ul id="add-results" class="add-results"></ul>
    <footer><button class="btn" data-action="close-modal">Cancel</button></footer>`);
  const box = $('#add-search');
  let timer;
  const search = async () => {
    const results = await api('/api/catalog', { sessionId: state.view.sessionId, inv: target.inv, q: box.value });
    $('#add-results').innerHTML = results.length
      ? results
          .map((r) => `
        <li class="add-row ${r.limit === null ? 'unavailable' : ''}" ${r.reason ? `title="${esc(r.reason)}"` : ''}>
          ${r.icon ? `<img class="thumb" src="/icons/${encodeURIComponent(r.id)}.png" alt="" loading="lazy">` : '<span class="thumb"></span>'}
          <div class="add-name"><b>${esc(r.name)}</b><div class="muted small">${esc(r.subtitle ?? r.type)} · <span class="mono">${esc(r.id)}</span></div></div>
          ${r.limit === null
            ? '<span class="muted small">limit unknown</span>'
            : `<input type="number" min="1" max="${r.limit}" value="${r.limit}" aria-label="Amount of ${esc(r.name)}" data-add-amount="${esc(r.id)}">
               <button class="btn small primary" data-action="add-confirm" data-id="${esc(r.id)}" data-inv="${esc(target.inv)}" data-x="${target.x}" data-y="${target.y}">Add</button>`}
        </li>`)
          .join('')
      : '<li class="muted">No matching items.</li>';
  };
  box.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(search), 150);
  });
  box.focus();
  await run(search);
}

// Units, Nanites and Quicksilver across the top of the middle column, on every save page.
function renderCurrencies() {
  const v = state.view;
  if (!v?.currencies) return '';
  return `
    <div class="currency-bar">${Object.entries(v.currencies)
      .map(([k, n]) => `
      <label class="currency" title="Click to edit ${CURRENCY_LABELS[k]}">
        <small>${CURRENCY_LABELS[k]}</small>
        <input data-currency="${k}" value="${fmt(n)}" inputmode="numeric" aria-label="${CURRENCY_LABELS[k]}">
      </label>`)
      .join('')}
    </div>`;
}

function renderEditor() {
  const c = state.view.containers.find((x) => x.id === state.selected);
  app.innerHTML = `
    ${renderSidebar()}
    <section class="content">${renderCurrencies()}${
      state.selected === 'words' ? renderWords()
        : state.selected === 'blueprints' ? renderBlueprints()
        : state.selected?.startsWith('group:') ? renderGroup(state.selected.slice(6))
        : state.selected === 'items' || !c ? renderItems()
        : renderContainer(c)
    }</section>
    ${renderDetails()}`;
}

function render() {
  renderTopbar();
  if (state.view?.kind === 'account') renderRewards();
  else if (state.view) renderEditor();
  else renderHome();
}

// ---- words and blueprints (per save) ------------------------------------------------------

state.bpFilter = 'unknown';
state.bpSel = new Set();

function shownBlueprints() {
  const q = state.search.trim().toLowerCase();
  return state.view.knowledge.blueprints.filter((b) => {
    if (state.bpFilter === 'unknown' && b.known) return false;
    if (state.bpFilter === 'known' && !b.known) return false;
    return !q || (b.name ?? '').toLowerCase().includes(q) || b.id.toLowerCase().includes(q);
  });
}

function renderWords() {
  const k = state.view.knowledge;
  return `
    <h2 class="with-icon">${icon('words', 22)}Words</h2>
    <p class="sub">Alien words learned in this save. Only entries from the game’s own word table are added.</p>
    <div class="word-grid">${k.words.map((w) => `
      <div class="word-card">
        <b>${esc(w.name)}</b><span class="mono muted">${fmt(w.known)} / ${fmt(w.total)} words</span>
        <span class="bar"><i style="width:${w.total ? (w.known / w.total) * 100 : 0}%"></i></span>
        <button class="btn small" data-action="learn-words" data-race="${w.race}" ${w.known >= w.total ? 'disabled' : ''}>${w.known >= w.total ? 'All known' : 'Learn all'}</button>
      </div>`).join('')}</div>`;
}

function renderBlueprints() {
  const k = state.view.knowledge;
  const shown = shownBlueprints();
  const unknownShown = shown.filter((b) => !b.known);
  const sel = [...state.bpSel].filter((id) => k.blueprints.some((b) => b.id === id && !b.known));
  return `
    <h2 class="with-icon">${icon('blueprints', 22)}Blueprints</h2>
    <p class="sub">Blueprints learned in this save: <span class="mono">${fmt(k.blueprints.filter((b) => b.known).length)} / ${fmt(k.blueprints.length)}</span>. Only entries from the game’s own blueprint trees are added.</p>
    <section class="inv">
      <div class="reward-bar">
        <div class="tabs">${['unknown', 'known', 'all'].map((f) => `<button class="tab small ${f === state.bpFilter ? 'active' : ''}" data-bp-filter="${f}">${f === 'unknown' ? 'Not learned' : f === 'known' ? 'Learned' : 'All'}</button>`).join('')}</div>
        <input type="search" id="bp-search" placeholder="Search blueprints…" value="${esc(state.search)}" aria-label="Search blueprints">
      </div>
      <div class="reward-actions">
        <button class="btn primary" data-action="learn-selected" ${sel.length ? '' : 'disabled'}>Learn selected (${sel.length})</button>
        <button class="btn" data-action="learn-shown" ${unknownShown.length ? '' : 'disabled'}>Learn all ${state.search ? 'matching' : 'shown'} (${unknownShown.length})</button>
      </div>
      <div class="reward-grid">${shown.slice(0, 300).map((b) => `
        <button class="reward ${b.known ? 'is-unlocked' : ''} ${sel.includes(b.id) ? 'selected' : ''}" data-bp="${esc(b.id)}" ${b.known ? 'disabled' : ''}>
          ${b.icon ? `<img src="/icons/${encodeURIComponent(b.id)}.png" alt="" loading="lazy">` : '<span class="reward-noicon"></span>'}
          <span class="reward-text"><b>${esc(b.name ?? b.id)}</b><span class="muted small">${esc(b.subtitle ?? b.type ?? '')}</span><span class="mono muted">${esc(b.id)}</span></span>
          ${b.known ? '<span class="tag ok">Learned</span>' : `<span class="check">${sel.includes(b.id) ? '✓' : ''}</span>`}
        </button>`).join('') || '<p class="muted">Nothing to show.</p>'}</div>
      ${shown.length > 300 ? `<p class="muted">Showing 300 of ${fmt(shown.length)}; search to narrow down.</p>` : ''}
    </section>`;
}

// ---- item catalogue (modal, works with or without a save) ------------------------

state.cat = { type: '', query: '', results: null };

function openCatalogue() {
  modal(`
    <h2 class="with-icon">${icon('shapes', 20)}All Items</h2>
    <p class="muted">Every named item in your installed game, read from its data files.</p>
    <div class="reward-bar">
      <div class="tabs" data-cat-tabs>${catalogueTabs()}</div>
      <input type="search" id="cat-search" placeholder="Search items…" value="${esc(state.cat.query)}" aria-label="Search items" autocomplete="off">
    </div>
    <div id="cat-results"><p class="muted">Loading…</p></div>
    <footer><button class="btn" data-action="close-modal">Close</button></footer>`, { wide: true });
  $('#cat-search').focus();
  return run(loadCatalogue);
}

const catalogueTabs = () =>
  ['', 'Substance', 'Product', 'Technology'].map((t) => `<button class="tab small ${t === state.cat.type ? 'active' : ''}" data-cat-type="${t}">${t || 'All'}</button>`).join('');

// Fetches and redraws only the results, so the search box keeps focus while typing.
async function loadCatalogue() {
  state.cat.results = await api('/api/browse', { q: state.cat.query, type: state.cat.type });
  const box = $('#cat-results');
  if (!box) return;
  const r = state.cat.results;
  box.innerHTML = `
    <p class="muted small">${fmt(r.total)} item${r.total === 1 ? '' : 's'}${r.total > r.items.length ? `, showing the first ${r.items.length}` : ''}</p>
    <div class="cat-list">${r.items.map((i) => `
      <div class="cat-row t-${esc(i.type)}">
        ${i.icon ? `<img class="cat-icon" src="/icons/${encodeURIComponent(i.id)}.png" alt="" loading="lazy">` : '<span class="cat-icon"></span>'}
        <div><b>${esc(i.name)}</b> <span class="muted small">· ${esc(i.subtitle ?? i.type)}</span>
          ${i.desc ? `<p class="desc">${esc(i.desc)}</p>` : ''}
          <div class="cat-meta"><span class="dot"></span>${esc(i.type)} · <span class="mono">${esc(i.id)}</span>${i.stack === 0 ? ' · doesn’t stack' : i.stack ? ` · stack ×${fmt(i.stack)}` : ''}${i.core ? ' · core tech' : ''}${i.chargeable ? ' · uses charge' : ''}${i.procedural ? ' · procedural' : ''}</div>
        </div>
        ${ownership(i)}
      </div>`).join('')}</div>`;
  const tabs = $('[data-cat-tabs]');
  if (tabs) tabs.innerHTML = catalogueTabs();
}

// With a save open: where a catalogue item already is, or a [+] to add it.
const baseIdOf = (id) => String(id).replace(/^\^/, '').split('#')[0];

function ownedLocations(id) {
  return allInventories().flatMap((inv) => inv.slots.filter((s) => baseIdOf(s.id) === id).map((slot) => ({ inv, slot })));
}

function ownership(item) {
  if (!state.view?.containers) return '';
  const where = ownedLocations(item.id);
  if (where.length) {
    const total = where.reduce((n, l) => n + (l.slot.type === 'Technology' ? 1 : l.slot.amount), 0);
    const first = where[0];
    return `
      <div class="cat-owned">
        <span class="owned">In ${where.length} place${where.length === 1 ? '' : 's'}${item.type === 'Technology' ? '' : ` · ${fmt(total)} total`}</span>
        <button class="btn small" data-jump="${esc(first.inv.container.id)}" data-inv="${esc(first.inv.id)}" data-x="${first.slot.x}" data-y="${first.slot.y}" title="${esc(where.map((l) => `${l.inv.container.title} · ${l.inv.label}`).join('\n'))}">${icon('show', 14)}Show</button>
      </div>`;
  }
  return `
    <div class="cat-owned">
      <span class="muted small">Not in your inventories</span>
      ${item.addable
        ? `<button class="btn small" data-action="cat-add" data-id="${esc(item.id)}" data-name="${esc(item.name)}" aria-label="Add ${esc(item.name)} to an inventory" title="Add to an inventory">${icon('add', 14)}Add</button>`
        : ''}
    </div>`;
}

// Pick where a catalogue item goes: inventories with free cells and the game's limit there.
async function openCatalogueAdd(id, name) {
  const targets = await api('/api/add-targets', { sessionId: state.view.sessionId, id });
  const usable = targets.filter((t) => !t.reason);
  modal(`
    <h2 class="with-icon">${icon('shapes', 20)}Add ${esc(name)}</h2>
    <p class="muted">It goes into the first free unlocked cell of the inventory you pick, with the game's stack limit for it there. Like any edit, it's staged until you save.</p>
    <div class="add-targets">${targets.map((t, i) => `
      <label class="add-target ${t.reason ? 'unavailable' : ''}" ${t.reason ? `title="${esc(t.reason)}"` : ''}>
        <input type="radio" name="add-target" value="${i}" ${t.reason ? 'disabled' : ''} ${t === usable[0] ? 'checked' : ''}>
        <span><b>${esc(t.where)}</b><span class="muted small">${t.reason ? esc(t.reason) : `${t.free} free · stacks to ${fmt(t.limit)}`}</span></span>
      </label>`).join('') || '<p class="muted">No inventory can take new items.</p>'}
    </div>
    <label class="add-amount">Amount <input type="number" id="cat-add-amount" min="1" value="${usable[0]?.limit ?? 1}" max="${usable[0]?.limit ?? 1}"></label>
    <footer>
      <button class="btn" data-action="catalogue">Back to catalogue</button>
      <button class="btn primary" data-action="cat-add-confirm" data-id="${esc(id)}" ${usable.length ? '' : 'disabled'}>Add</button>
    </footer>`, { wide: true });
  state.cat.addTargets = targets;
  // Picking an inventory resets the amount to a full stack there.
  for (const radio of document.querySelectorAll('[name="add-target"]')) {
    radio.addEventListener('change', () => {
      const t = targets[Number(radio.value)];
      const amount = $('#cat-add-amount');
      amount.max = t.limit;
      amount.value = t.limit;
    });
  }
}

async function confirmCatalogueAdd(id) {
  const t = state.cat.addTargets?.[Number(document.querySelector('[name="add-target"]:checked')?.value)];
  if (!t) return toast('Choose an inventory', true);
  const amount = Number($('#cat-add-amount').value);
  const before = state.view.ops;
  await applyOp({ op: 'add', inv: t.inv, x: t.cell[0], y: t.cell[1], id, amount });
  if (state.view.ops > before) {
    toast(`Added ${fmt(amount)} to ${t.where}`);
    openCatalogue();
  }
}

// ---- save slot menu ------------------------------------------------------------

async function openSlotMenu(account, file) {
  const acc = state.accounts.find((a) => a.id === account);
  const slots = await api('/api/slots');
  const existing = new Map(acc.slots.map((s) => [s.file, s]));
  const options = slots.filter((f) => f !== file).map((f, i) => {
    const s = existing.get(f);
    const n = Math.ceil((slots.indexOf(f) + 1) / 2);
    return `<option value="${esc(f)}" data-exists="${s ? 1 : 0}">Slot ${n} · ${esc(f)} — ${s ? esc(s.summary ?? 'save') : 'empty'}</option>`;
  });
  modal(`
    <h2>${esc(file)}</h2>
    <p class="muted">${esc(existing.get(file)?.summary ?? '')}. Every change here is backed up first and can be restored from Backups.</p>
    <h3 class="modal-sub">Copy, move or swap</h3>
    <select id="slot-target" class="slot-select" aria-label="Target slot">${options.join('')}</select>
    <div class="stack-row" style="margin-top:8px">
      <button class="btn" data-action="slot-op" data-op="copy" data-account="${esc(account)}" data-file="${esc(file)}">Copy here</button>
      <button class="btn" data-action="slot-op" data-op="move" data-account="${esc(account)}" data-file="${esc(file)}">Move here</button>
      <button class="btn" data-action="slot-op" data-op="swap" data-account="${esc(account)}" data-file="${esc(file)}">Swap with it</button>
    </div>
    <footer><button class="btn" data-action="close-modal">Close</button></footer>`);
}

async function runSlotOp(d) {
  const to = $('#slot-target')?.value;
  const targetExists = $('#slot-target')?.selectedOptions[0]?.dataset.exists === '1';
  const what = { copy: `Copy ${d.file} to ${to}`, move: `Move ${d.file} to ${to}`, swap: `Swap ${d.file} and ${to}`, delete: `Delete ${d.file}` }[d.op];
  const overwrite = (d.op === 'copy' || d.op === 'move') && targetExists ? ` This replaces the save in ${to}.` : '';
  const separate = d.op === 'copy' || d.op === 'move' ? ' Placed in another slot, it gets a new save ID so the game treats it as a separate save.' : '';
  // Steam Cloud re-downloads files deleted outside the game the next time it syncs.
  const isSteam = state.accounts.find((a) => a.id === d.account)?.kind === 'Steam';
  const cloud = isSteam && (d.op === 'delete' || d.op === 'move')
    ? `\n\nSteam Cloud may bring back ${d.file} the next time the game starts. To delete a save for good, delete it from the game’s own load menu.`
    : '';
  if (!(await ask(`${what}?${overwrite}${separate} A backup is taken first.${cloud}`, { ok: what.split(' ')[0], danger: d.op === 'delete' }))) return;
  await run(async () => {
    const r = await api('/api/slot', { account: d.account, op: d.op, from: d.file, to });
    closeModal();
    toast(`${what}: done${r.verified ? ', verified' : ''}`, !r.verified);
    state.verify = {};
    await loadAccounts();
  });
}

async function exportJson(account, file) {
  await run(async () => {
    const r = await api('/api/export', { account, file });
    const url = URL.createObjectURL(new Blob([r.json], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: r.name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`Exported ${r.name}`);
  });
}

// ---- account rewards ---------------------------------------------------------

state.rewardTab = 'season';
state.rewardFilter = 'locked';
state.rewardSel = new Set();

function shownRewards() {
  const q = state.search.trim().toLowerCase();
  return state.view.lists[state.rewardTab].rewards.filter((r) => {
    if (state.rewardFilter === 'locked' && r.unlocked) return false;
    if (state.rewardFilter === 'unlocked' && !r.unlocked) return false;
    return !q || (r.name ?? '').toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.item.toLowerCase().includes(q);
  });
}

function renderRewards() {
  const lists = state.view.lists;
  const list = lists[state.rewardTab];
  const shown = shownRewards();
  const lockedShown = shown.filter((r) => !r.unlocked);
  const sel = [...state.rewardSel].filter((id) => list.rewards.some((r) => r.id === id && !r.unlocked));
  const count = (l) => `${l.rewards.filter((r) => r.unlocked).length} / ${l.rewards.length}`;
  app.innerHTML = `
    <section class="rewards">
      <h2>Account rewards</h2>
      <p class="sub">Unlocked rewards become claimable in-game for every save on this account, from the expedition rewards terminal on the Space Anomaly. This edits <span class="mono">accountdata.hg</span>, with the same review, backup and verification as saves.</p>
      ${state.view.gamedata ? '' : '<div class="warnings">Reward names need the game’s data files, which weren’t found.</div>'}
      <div class="reward-bar">
        <div class="tabs" role="tablist">${Object.entries(lists).map(([k, l]) => `<button class="tab ${k === state.rewardTab ? 'active' : ''}" role="tab" data-reward-tab="${k}">${esc(l.label)} <span class="muted">${count(l)}</span></button>`).join('')}</div>
        <div class="tabs">${['locked', 'unlocked', 'all'].map((f) => `<button class="tab small ${f === state.rewardFilter ? 'active' : ''}" data-reward-filter="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}</div>
        <input type="search" id="search" placeholder="Search rewards…" value="${esc(state.search)}" aria-label="Search rewards">
      </div>
      <div class="reward-actions">
        <button class="btn primary" data-action="unlock-selected" ${sel.length ? '' : 'disabled'}>Unlock selected (${sel.length})</button>
        <button class="btn" data-action="unlock-shown" ${lockedShown.length ? '' : 'disabled'}>Unlock all ${state.search ? 'matching' : 'locked'} (${lockedShown.length})</button>
        ${sel.length ? '<button class="btn small" data-action="clear-selection">Clear selection</button>' : ''}
      </div>
      <div class="reward-grid">${shown.map((r) => rewardCard(r, sel.includes(r.id))).join('') || '<p class="muted">Nothing to show.</p>'}</div>
    </section>`;
}

function rewardCard(r, selected) {
  const status = r.pending ? '<span class="tag pending">Unlocking</span>' : r.unlocked ? '<span class="tag ok">Unlocked</span>' : '';
  return `
    <button class="reward ${r.unlocked ? 'is-unlocked' : ''} ${selected ? 'selected' : ''}" data-reward="${esc(r.id)}" ${r.unlocked ? 'disabled' : ''} aria-pressed="${selected}">
      ${r.icon && r.key ? `<img src="/icons/${encodeURIComponent(r.key)}.png" alt="" loading="lazy">` : '<span class="reward-noicon"></span>'}
      <span class="reward-text"><b>${esc(r.name ?? r.id)}</b><span class="muted small">${esc(r.subtitle ?? '')}</span><span class="mono muted">${esc(r.id)}</span></span>
      ${status || `<span class="check">${selected ? '✓' : ''}</span>`}
    </button>`;
}

function unlock(ids) {
  if (!ids.length) return;
  return applyOp({ op: 'unlockRewards', list: state.rewardTab, ids }).then(() => state.rewardSel.clear()).then(render);
}

// ---- modals ----------------------------------------------------------------

// Confirmation in the page itself. Browsers can silently suppress window.confirm()
// ("prevent this page from creating additional dialogs"), which made buttons do nothing.
function ask(message, { ok = 'Continue', danger = false } = {}) {
  return new Promise((resolve) => {
    const root = $('#confirm-root');
    root.innerHTML = `
      <div class="modal-backdrop confirm-backdrop">
        <div class="modal confirm" role="alertdialog" aria-modal="true" aria-label="Confirm">
          <p class="confirm-text">${esc(message).replace(/\n/g, '<br>')}</p>
          <footer>
            <button class="btn" data-confirm="cancel">Cancel</button>
            <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-confirm="ok">${esc(ok)}</button>
          </footer>
        </div>
      </div>`;
    const done = (answer) => {
      root.innerHTML = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('[data-confirm="ok"]').addEventListener('click', (e) => { e.stopPropagation(); done(true); });
    root.querySelector('[data-confirm="cancel"]').addEventListener('click', (e) => { e.stopPropagation(); done(false); });
    root.querySelector('[data-confirm="ok"]').focus();
  });
}

function modal(html, { wide = false } = {}) {
  releaseModal?.();
  releaseModal = null;
  $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="close-modal"><div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
}
function closeSaveMenu() {
  state.saveMenu = null;
  state.rewardsMenu = false;
  $('.save-menu')?.remove();
  document.querySelector('[aria-haspopup="menu"][aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
}

let releaseModal = null;
const closeModal = () => {
  releaseModal?.();
  releaseModal = null;
  $('#modal-root').innerHTML = '';
};

async function openModel(id) {
  const c = state.view.containers.find((x) => x.id === id);
  modal(`
    <h2 class="with-icon">${icon('model', 20)}${esc(c.title)}</h2>
    <p class="sub">${esc(c.subtitle ?? c.group)} · drag to rotate, scroll to zoom. Shown in the model's default colours.</p>
    <div class="model-stage"><canvas aria-label="3D model of ${esc(c.title)}"></canvas><div class="model-status muted">Loading model…</div></div>
    <footer><button class="btn" data-action="close-modal">Close</button></footer>`, { wide: true });
  const stage = $('#modal-root .model-stage');
  try {
    const { release, omitted } = await showModel(stage.querySelector('canvas'), c.model.scene, c.model.parts);
    if (!stage.isConnected) return release(); // closed while loading
    releaseModal = release;
    stage.querySelector('.model-status').remove();
    if (omitted.includes('decals')) {
      stage.insertAdjacentHTML('afterend', '<p class="muted small">Decals such as hull lettering and signs are left out: the game picks them from a seed it doesn’t write to the save.</p>');
    }
  } catch (e) {
    if (stage.isConnected) stage.querySelector('.model-status').textContent = e.message;
  }
}

const checkList = (checks) => `
  <ul class="checks">${checks
    .map((c) => `<li><span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</span><span>${esc(c.name)}</span>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</li>`)
    .join('')}</ul>`;

const typeLabel = (scene) => state.view.containers.flatMap((c) => c.manage?.kinds ?? []).find((k) => k.scene === scene)?.label ?? scene;

function describeOp(op) {
  const at = (r) => {
    const inv = findInv(r.inv);
    return inv ? `${inv.container.title} · ${inv.label}` : r.inv;
  };
  switch (op.op) {
    case 'setAmount': return `Set amount to ${fmt(op.amount)} in ${at(op)}`;
    case 'remove': return `Remove item from ${at(op)} (${op.x}, ${op.y})`;
    case 'move': return `Move item from ${at(op.from)} to ${at(op.to)}`;
    case 'setCurrency': return `Set ${CURRENCY_LABELS[op.field]} to ${fmt(op.value)}`;
    case 'rename': return `Rename to “${op.name}”`;
    case 'setShipType': return `Change ship type to ${typeLabel(op.scene)}`;
    case 'setFreighterType': return `Change freighter type to ${typeLabel(op.scene)}`;
    case 'deleteShip': return 'Delete a ship';
    case 'add': return `Add ${fmt(op.amount)} × ${itemName(`^${op.id}`)} to ${at(op)} (${op.x}, ${op.y})`;
    case 'recharge': return `Recharge technology in ${at(op)} (${op.x}, ${op.y})`;
    case 'sortInventory': return `Sort ${at(op)} by ${op.by}${op.combine ? ', combining stacks' : ''}`;
    case 'unlockSlots': return op.x === undefined ? `Unlock all slots in ${at(op)}` : `Unlock slot (${op.x}, ${op.y}) in ${at(op)}`;
    case 'repair': return `Repair technology in ${at(op)} (${op.x}, ${op.y})`;
    case 'learnWords': return `Learn all ${op.races.map((r) => state.view.knowledge?.words.find((w) => w.race === r)?.name ?? r).join(', ')} words`;
    case 'learnBlueprints': return `Learn ${op.ids.length} blueprint${op.ids.length === 1 ? '' : 's'}: ${op.ids.slice(0, 4).map((id) => state.view.knowledge?.blueprints.find((b) => b.id === id)?.name ?? id).join(', ')}${op.ids.length > 4 ? `, and ${op.ids.length - 4} more` : ''}`;
    case 'unlockRewards': {
      const names = op.ids.map((id) => state.view.lists?.[op.list]?.rewards.find((r) => r.id === id)?.name ?? id);
      const label = (state.view.lists?.[op.list]?.label.toLowerCase() ?? 'rewards').replace(/s$/, op.ids.length === 1 ? '' : 's');
      return `Unlock ${op.ids.length} ${label}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? `, and ${names.length - 4} more` : ''}`;
    }
    default: return op.op;
  }
}

async function openReview() {
  await run(async () => {
    const r = await api('/api/review', { sessionId: state.view.sessionId });
    modal(`
      <h2>Review changes</h2>
      <p class="muted">${r.ops.length} change(s) will be written to <span class="mono">${esc(state.view.file)}</span>. A verified backup is taken first.</p>
      <ol class="changes">${r.ops.map((op) => `<li>${esc(describeOp(op))}</li>`).join('')}</ol>
      ${r.warnings.length ? `<div class="warnings">${r.warnings.map(esc).join('<br>')}</div>` : ''}
      <h3 style="margin:16px 0 0;font-size:14px">Safety checks</h3>
      ${checkList(r.checks)}
      <footer>
        <button class="btn" data-action="close-modal">Cancel</button>
        <button class="btn primary" data-action="commit" ${r.ok ? '' : 'disabled'}>Write to save</button>
      </footer>`);
  });
}

async function commit() {
  await run(async () => {
    const r = await api('/api/commit', { sessionId: state.view.sessionId });
    if (!r.ok) {
      modal(`<h2>Write refused</h2>${checkList(r.checks)}<footer><button class="btn" data-action="close-modal">Close</button></footer>`);
      return;
    }
    const { account, file } = state.view;
    modal(`
      <h2>Saved</h2>
      <p>Your changes were written and read back successfully.</p>
      ${checkList(r.checks)}
      <p class="muted">Backup: <span class="mono">${esc(r.backupDir)}</span></p>
      <footer><button class="btn primary" data-action="close-modal">Done</button></footer>`);
    state.view = await api('/api/open', { account, file });
    render();
  });
}

async function openBackups(account) {
  await run(async () => {
    const list = await api('/api/backups', { account });
    modal(`
      <h2>Backups</h2>
      <p class="muted">Taken automatically before every write and restore.</p>
      ${
        list.length
          ? `<ul class="checks">${list
              .map((b) => `<li><span>⟲</span><span><b>${esc(b.file)}</b> · ${new Date(b.created).toLocaleString()}<br><small class="muted">${esc(b.reason)}</small></span>
                 <small><button class="btn small" data-action="restore" data-account="${esc(account)}" data-backup="${esc(b.id)}">Restore</button></small></li>`)
              .join('')}</ul>`
          : '<p>No backups yet.</p>'
      }
      <footer><button class="btn" data-action="close-modal">Close</button></footer>`);
  });
}

// ---- events ----------------------------------------------------------------

async function loadAccounts() {
  await run(async () => {
    [state.accounts, state.gamedata, state.where] = await Promise.all([api('/api/accounts'), state.gamedata ?? api('/api/gamedata'), state.where ?? api('/api/where')]);
    const banner = $('#test-banner');
    banner.hidden = !state.where.testMode;
    banner.innerHTML = state.where.testMode
      ? `<b>Test folder</b>, not your game saves: changes are written to <span class="mono">${esc(state.where.saveRoots[0])}</span> and will not appear in No Man’s Sky.`
      : '';
    render();
  });
}

document.addEventListener('click', async (e) => {
  // Any click closes an open save menu; its own items still run below.
  if ((state.saveMenu || state.rewardsMenu) && !e.target.closest('[data-action="save-menu"],[data-action="rewards-menu"]')) closeSaveMenu();
  const t = e.target.closest('[data-action],[data-select],[data-slot],[data-cell],[data-jump],[data-reward],[data-reward-tab],[data-reward-filter],[data-bp],[data-bp-filter],[data-cat-type]');
  if (!t) return;
  if (t.matches('.modal-backdrop') && e.target !== t) return;
  const d = t.dataset;

  if (d.bp) {
    if (state.bpSel.has(d.bp)) state.bpSel.delete(d.bp);
    else state.bpSel.add(d.bp);
    return render();
  }
  if (d.bpFilter) {
    state.bpFilter = d.bpFilter;
    state.bpSel.clear();
    return render();
  }
  if (d.catType !== undefined) {
    state.cat.type = d.catType;
    return run(loadCatalogue);
  }

  if (d.reward) {
    if (state.rewardSel.has(d.reward)) state.rewardSel.delete(d.reward);
    else state.rewardSel.add(d.reward);
    return render();
  }
  if (d.rewardTab || d.rewardFilter) {
    if (d.rewardTab) state.rewardTab = d.rewardTab;
    if (d.rewardFilter) state.rewardFilter = d.rewardFilter;
    state.rewardSel.clear();
    return render();
  }
  if (d.jump) {
    closeModal(); // e.g. "Show" in the catalogue
    state.selected = d.jump;
    state.slot = { inv: d.inv, x: Number(d.x), y: Number(d.y) };
    render();
    return document.querySelector('.cell.selected')?.scrollIntoView({ block: 'center' });
  }
  if (d.select) {
    state.selected = d.select;
    state.slot = null;
    return render();
  }
  if (t.matches('[data-cell]') || d.slot !== undefined) {
    const cell = t.closest('[data-cell]');
    const inv = findInv(cell.dataset.inv);
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const occupied = slotAt(inv, x, y);
    const unlocked = inv.valid.includes(`${x},${y}`);
    // An empty locked cell unlocks on click, like buying that slot in game.
    if (!occupied && !unlocked && canUnlockSlots(inv)) return applyOp({ op: 'unlockSlots', inv: inv.id, x, y });
    // Filled cells and empty unlocked cells can be selected (an empty one to add an item).
    state.slot = occupied || unlocked ? { inv: inv.id, x, y } : null;
    return render();
  }

  switch (d.action) {
    case 'home':
      if (state.view?.ops && !(await ask('Discard unsaved changes?', { ok: 'Discard', danger: true }))) return;
      state.view = null;
      state.search = '';
      return loadAccounts();
    case 'verify':
      return run(async () => {
        state.verify[`${d.account}/${d.file}`] = await api('/api/verify', { account: d.account, file: d.file });
        render();
      });
    case 'rewards-menu':
      state.rewardsMenu = !state.rewardsMenu;
      return renderTopbar();
    case 'open-rewards':
      if (state.view?.kind === 'account') return;
      if (state.view?.ops && !(await ask('Discard unsaved changes?', { ok: 'Discard', danger: true }))) return;
    // falls through
    case 'open':
      return run(async () => {
        state.view = await api('/api/open', { account: d.account, file: d.file });
        state.selected = state.view.containers?.[0]?.id;
        state.slot = null;
        state.search = '';
        state.rewardSel.clear();
        render();
      });
    case 'undo':
      return run(async () => { state.view = await api('/api/undo', { sessionId: state.view.sessionId }); render(); });
    case 'reset':
      if (!(await ask('Discard all pending changes?', { ok: 'Discard', danger: true }))) return;
      return run(async () => { state.view = await api('/api/reset', { sessionId: state.view.sessionId }); render(); });
    case 'review':
      return openReview();
    case 'commit':
      return commit();
    case 'close-modal':
      return closeModal();
    case 'details-toggle':
      return toggleDetails();
    case 'backups':
      return openBackups(d.account);
    case 'restore':
      if (!(await ask('Restore this backup over the current save? The current files are backed up first.', { ok: 'Restore' }))) return;
      return run(async () => {
        const r = await api('/api/restore', { account: d.account, backup: d.backup });
        closeModal();
        toast(`Restored ${r.restored}`);
        loadAccounts();
      });
    case 'fill': {
      const s = slotAt(findInv(state.slot.inv), state.slot.x, state.slot.y);
      return applyOp({ op: 'setAmount', ...state.slot, amount: s.max });
    }
    case 'remove': {
      const s = slotAt(findInv(state.slot.inv), state.slot.x, state.slot.y);
      if (s?.type === 'Technology' && !(await ask(`Remove ${itemName(s.id)}? It will be gone from the save once written (a backup is kept).`, { ok: 'Remove', danger: true }))) return;
      return applyOp({ op: 'remove', ...state.slot });
    }
    case 'recharge':
    case 'repair':
      return applyOp({ op: d.action, ...state.slot });
    case 'add-item':
      return openAddItem();
    case 'unlock-slots':
      return applyOp({ op: 'unlockSlots', inv: d.inv });
    case 'sort': {
      const tools = t.closest('.inv-tools');
      state.sortBy = tools.querySelector('[data-sort-by]').value;
      state.sortCombine = tools.querySelector('[data-sort-combine]').checked;
      state.slot = null;
      return applyOp({ op: 'sortInventory', inv: d.inv, by: state.sortBy, combine: state.sortCombine });
    }
    case 'model':
      return openModel(d.container);
    case 'catalogue':
      // A modal over whatever is showing; a save stays open with its staged changes.
      return openCatalogue();
    case 'cat-add':
      return run(() => openCatalogueAdd(d.id, d.name));
    case 'cat-add-confirm':
      return confirmCatalogueAdd(d.id);
    case 'save-menu': {
      const key = `${d.account}/${d.file}`;
      state.saveMenu = state.saveMenu === key ? null : key;
      return render();
    }
    case 'change-type':
      return openTypeChange(d.container);
    case 'type-confirm': {
      const c = state.view.containers.find((x) => x.id === d.container);
      const chosen = $('#modal-root input[name="kind"]:checked');
      const scene = chosen?.value;
      if (!scene || chosen.dataset.current) return toast('Choose a different type first', true);
      closeModal();
      return applyOp(c.freighter ? { op: 'setFreighterType', scene } : { op: 'setShipType', ship: c.ship, scene });
    }
    case 'delete-ship': {
      const c = state.view.containers.find((x) => x.id === d.container);
      const count = c.inventories.reduce((n, i) => n + i.slots.length, 0);
      if (!(await ask(`Delete ${c.title}? It and the ${count} item${count === 1 ? '' : 's'} and technology in it are removed from this save once written (a backup is kept).`, { ok: 'Delete', danger: true }))) return;
      state.selected = 'group:Starships';
      state.slot = null;
      return applyOp({ op: 'deleteShip', ship: c.ship });
    }
    case 'slot-menu':
      return run(() => openSlotMenu(d.account, d.file));
    case 'slot-op':
      return runSlotOp(d);
    case 'export-json':
      return exportJson(d.account, d.file);
    case 'learn-words':
      return applyOp({ op: 'learnWords', races: [Number(d.race)] });
    case 'learn-selected':
      return applyOp({ op: 'learnBlueprints', ids: [...state.bpSel] }).then(() => { state.bpSel.clear(); render(); });
    case 'learn-shown': {
      const ids = shownBlueprints().filter((b) => !b.known).map((b) => b.id);
      if (ids.length > 10 && !(await ask(`Learn ${ids.length} blueprints? You can still review before anything is written.`, { ok: 'Learn' }))) return;
      return applyOp({ op: 'learnBlueprints', ids }).then(() => { state.bpSel.clear(); render(); });
    }
    case 'unlock-selected':
      return unlock([...state.rewardSel]);
    case 'unlock-shown': {
      const ids = shownRewards().filter((r) => !r.unlocked).map((r) => r.id);
      if (ids.length > 10 && !(await ask(`Unlock ${ids.length} rewards? You can still review before anything is written.`, { ok: 'Unlock' }))) return;
      return unlock(ids);
    }
    case 'clear-selection':
      state.rewardSel.clear();
      return render();
    case 'add-confirm': {
      const amount = Number($(`[data-add-amount="${CSS.escape(d.id)}"]`)?.value);
      const before = state.view.ops;
      await applyOp({ op: 'add', inv: d.inv, x: Number(d.x), y: Number(d.y), id: d.id, amount });
      if (state.view.ops > before) closeModal();
      return;
    }
    case 'rename': {
      const name = prompt('New name', d.name);
      if (name === null || name === d.name) return;
      return applyOp({ op: 'rename', target: d.nameKey, name });
    }
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.dataset.form !== 'amount') return;
  e.preventDefault();
  applyOp({ op: 'setAmount', ...state.slot, amount: Number(new FormData(e.target).get('amount')) });
});

document.addEventListener('input', (e) => {
  const { id } = e.target;
  if (id !== 'search' && id !== 'bp-search') return;
  state.search = e.target.value;
  const pos = e.target.selectionStart;
  const refocus = () => {
    const box = document.getElementById(id);
    box?.focus();
    box?.setSelectionRange(pos, pos);
  };
  render();
  refocus();
});

// The catalogue searches on the server; wait for typing to pause.
let catalogueTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'cat-search') return;
  state.cat.query = e.target.value;
  clearTimeout(catalogueTimer);
  catalogueTimer = setTimeout(() => run(loadCatalogue), 200);
});

document.addEventListener('focusin', (e) => {
  if (e.target.dataset.currency) e.target.value = e.target.value.replace(/[^\d]/g, '');
});
document.addEventListener('focusout', (e) => {
  const field = e.target.dataset.currency;
  if (!field) return;
  const value = Number(e.target.value.replace(/[^\d]/g, ''));
  // Unchanged: just restore the formatting (a full redraw here could swallow the click
  // that moved focus away).
  if (value === state.view.currencies[field]) return (e.target.value = fmt(value));
  applyOp({ op: 'setCurrency', field, value });
});
// ---- keyboard shortcuts ------------------------------------------------------
// Each shortcut does exactly what its button does: staged, undoable, same rules.

const SHORTCUTS = [
  ['← ↑ → ↓', 'Move the selection between cells'],
  ['Delete', 'Remove the selected item'],
  ['F', 'Fill the selected stack'],
  ['S', 'Sort the selected (or first sortable) inventory'],
  ['R', 'Recharge or repair the selected technology'],
  ['U', 'Unlock the locked slots of the selected inventory'],
  ['A / Enter', 'Add an item to the selected empty cell'],
  ['/', 'Search'],
  ['⌘S', 'Review changes; ⌘S again (or Enter) writes the save'],
  ['⌘Z', 'Undo'],
  ['Esc', 'Close a dialog or clear the selection'],
  ['?', 'Show these shortcuts'],
];

function showShortcuts() {
  modal(`
    <h2>Keyboard shortcuts</h2>
    <table class="shortcuts">${SHORTCUTS.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>
    <footer><button class="btn" data-action="close-modal">Close</button></footer>`);
}

const typing = (el) => el.matches?.('input, textarea, select, [contenteditable="true"]');
const isMod = (e) => e.metaKey || e.ctrlKey;

// Next selectable cell (filled, or unlocked and empty) from the selection in a direction.
function stepSelection(dx, dy) {
  const inv = state.slot && findInv(state.slot.inv);
  if (!inv) {
    // Nothing selected yet: start at the first cell of the first grid on the page.
    const first = targetInventory(() => true);
    if (first) state.slot = { inv: first.id, x: 0, y: 0 };
    return render();
  }
  let { x, y } = state.slot;
  for (;;) {
    x += dx;
    y += dy;
    if (x < 0 || y < 0 || x >= inv.width || y >= inv.height) return;
    if (slotAt(inv, x, y) || inv.valid.includes(`${x},${y}`)) break;
  }
  state.slot = { inv: inv.id, x, y };
  render();
  document.querySelector('.cell.selected')?.scrollIntoView({ block: 'nearest' });
}

// The inventory a shortcut acts on: the selection's, else the first on the page that qualifies.
function targetInventory(ok) {
  const sel = state.slot && findInv(state.slot.inv);
  if (sel && ok(sel)) return sel;
  return [...document.querySelectorAll('[data-inv-section]')].map((el) => findInv(el.dataset.invSection)).find((i) => i && ok(i)) ?? null;
}

async function onShortcut(e) {
  const v = state.view;
  const inEditor = v && v.kind !== 'account' && !['words', 'blueprints', 'items'].includes(state.selected);
  const selected = state.slot && findInv(state.slot.inv);
  const s = selected && slotAt(selected, state.slot.x, state.slot.y);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const take = () => e.preventDefault();

  if (key === '?') return take(), showShortcuts();
  if (key === '/') {
    const box = $('#search');
    if (box) take(), box.focus();
    return;
  }
  if (!inEditor) return;
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[key]) return take(), stepSelection(...arrows[key]);
  if ((key === 'Delete' || key === 'Backspace') && s) return take(), document.querySelector('[data-action="remove"]')?.click();
  if (key === 'f' && s && s.type !== 'Technology') return take(), applyOp({ op: 'setAmount', ...state.slot, amount: s.max });
  if (key === 'r' && s?.type === 'Technology') return take(), (document.querySelector('[data-action="recharge"]:not(:disabled)') ?? document.querySelector('[data-action="repair"]'))?.click();
  if ((key === 'a' || key === 'Enter') && selected && !s && BULK.has(selected.kind)) return take(), openAddItem();
  if (key === 's') {
    const inv = targetInventory((i) => BULK.has(i.kind) && i.slots.some((x) => x.type !== 'Technology'));
    if (inv) take(), applyOp({ op: 'sortInventory', inv: inv.id, by: state.sortBy, combine: state.sortCombine });
    return;
  }
  if (key === 'u') {
    const inv = targetInventory((i) => canUnlockSlots(i) && i.valid.length < i.width * i.height);
    if (inv) take(), applyOp({ op: 'unlockSlots', inv: inv.id });
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.currency) e.target.blur();
  const reviewOpen = $('#modal-root [data-action="commit"]');
  if (e.key === 'Escape') {
    if (state.saveMenu || state.rewardsMenu) return closeSaveMenu();
    if ($('#modal-root .modal')) return closeModal();
    if (narrow.matches && state.detailsOverlayOpen && !typing(e.target)) return toggleDetails(false);
    if (state.slot && !typing(e.target)) {
      state.slot = null;
      return render();
    }
  }
  // ⌘S: open the review; ⌘S again (or Enter) in the review writes, if every check passed.
  if (isMod(e) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (reviewOpen) return reviewOpen.disabled ? toast('Some checks failed, so this can’t be written', true) : reviewOpen.click();
    if (state.view?.ops) return openReview();
    return toast('No changes to save');
  }
  if (e.key === 'Enter' && reviewOpen && !reviewOpen.disabled && !typing(e.target)) return e.preventDefault(), reviewOpen.click();
  if (isMod(e) && e.key === 'z' && state.view?.ops && !typing(e.target)) {
    e.preventDefault();
    return run(async () => { state.view = await api('/api/undo', { sessionId: state.view.sessionId }); render(); });
  }
  // Plain-key shortcuts: not while typing, not over a dialog, not with modifiers.
  if (isMod(e) || e.altKey || typing(e.target) || $('#modal-root .modal') || $('#confirm-root .confirm')) return;
  onShortcut(e);
});

// ---- item tooltip --------------------------------------------------------------

const DESC_MAX = 320;
let tipTimer = null;
let tipFor = null;

function tooltipHtml(s) {
  const meta = info(s.id);
  const desc = meta?.desc && (meta.desc.length > DESC_MAX ? `${meta.desc.slice(0, DESC_MAX).replace(/\s+\S*$/, '')}…` : meta.desc);
  const qty = s.type === 'Technology'
    ? (s.amount >= 0 && s.max > 0 && meta?.chargeable ? `Charge ${fmt(s.amount)} / ${fmt(s.max)}` : '')
    : `${fmt(s.amount)} / ${fmt(s.max)}`;
  const status = [s.damage > 0 ? (s.installed ? 'Broken slot' : 'Damaged') : '', meta?.core ? 'Core' : ''].filter(Boolean).join(' · ');
  return `
    <div class="tip-head t-${esc(s.type)}"><span class="dot"></span><b>${esc(itemName(s.id))}</b></div>
    ${meta?.subtitle ? `<div class="tip-sub">${esc(meta.subtitle)}</div>` : ''}
    ${qty || status ? `<div class="tip-qty">${esc([qty, status].filter(Boolean).join(' · '))}</div>` : ''}
    ${desc ? `<p class="tip-desc">${esc(desc)}</p>` : ''}
    <div class="tip-id mono">${esc(s.id)}</div>`;
}

function showTip(tile) {
  const cell = tile.closest('[data-cell]');
  const s = slotAt(findInv(cell.dataset.inv), Number(cell.dataset.x), Number(cell.dataset.y));
  if (!s) return;
  let tip = $('#item-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'item-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.append(tip);
  }
  tip.innerHTML = tooltipHtml(s);
  tip.hidden = false;
  // Beside the tile, flipped or clamped to stay inside the viewport.
  const r = tile.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 8;
  let left = r.right + gap;
  if (left + t.width > window.innerWidth - gap) left = r.left - gap - t.width;
  left = Math.max(gap, left);
  const top = Math.min(Math.max(gap, r.top), window.innerHeight - t.height - gap);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipFor = null;
  const tip = $('#item-tip');
  if (tip) tip.hidden = true;
}

document.addEventListener('mouseover', (e) => {
  const tile = e.target.closest?.('.tile');
  if (tile === tipFor) return;
  hideTip();
  if (!tile || dragFrom) return;
  tipFor = tile;
  tipTimer = setTimeout(() => showTip(tile), 250);
});
document.addEventListener('scroll', hideTip, true);
document.addEventListener('mousedown', hideTip);

// Why an item can't be dropped into an inventory, or null if it can. Mirrors the
// server's rules so blocked targets show before dropping; the server still decides.
function dropBlock(item, fromInvId, inv) {
  if (inv.id === fromInvId) return null;
  if (item.type === 'Technology') return 'Technology stays in its own grid';
  if (!BULK.has(inv.kind)) return `${inv.label} can’t receive items from elsewhere`;
  const trusted = state.view.stackTrust?.[inv.stackGroup]?.[item.type];
  const known = allInventories().some((i) => i.stackGroup === inv.stackGroup && i.slots.some((s) => s.id === item.id));
  return trusted || known ? null : `The game’s stack limit for ${itemName(item.id)} in ${inv.container.title} · ${inv.label} can’t be confirmed`;
}

function containerBlock(item, fromInvId, container) {
  const reasons = container.inventories.map((i) => dropBlock(item, fromInvId, { ...i, container }));
  return reasons.some((r) => r === null) ? null : reasons[0];
}

// Drag and drop: cell to cell, or cell to a sidebar container.
let dragFrom = null;
let dragItem = null;
const blocked = new Map(); // element -> reason, for the current drag

function markBlockedTargets() {
  blocked.clear();
  for (const el of document.querySelectorAll('[data-inv-section]')) {
    const reason = dropBlock(dragItem, dragFrom.inv, findInv(el.dataset.invSection));
    if (reason) blocked.set(el, reason);
  }
  for (const el of document.querySelectorAll('[data-drop-container]')) {
    const c = state.view.containers.find((x) => x.id === el.dataset.select);
    const reason = c && containerBlock(dragItem, dragFrom.inv, c);
    if (reason) blocked.set(el, reason);
  }
  for (const [el, reason] of blocked) {
    el.classList.add('no-drop');
    el.title = reason;
  }
}

function dragHint(text) {
  let el = $('#drag-hint');
  if (!el) {
    el = document.createElement('div');
    el.id = 'drag-hint';
    document.body.append(el);
  }
  el.textContent = text ?? '';
  el.hidden = !text;
}

document.addEventListener('dragstart', (e) => {
  const cell = e.target.closest?.('[data-cell]');
  if (!cell) return;
  dragFrom = { inv: cell.dataset.inv, x: Number(cell.dataset.x), y: Number(cell.dataset.y) };
  dragItem = slotAt(findInv(dragFrom.inv), dragFrom.x, dragFrom.y);
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', JSON.stringify(dragFrom));
  markBlockedTargets();
});
document.addEventListener('dragover', (e) => {
  const target = e.target.closest?.('[data-cell]:not(.locked), [data-drop-container]:not([data-drop-container=""])');
  if (!target || !dragFrom) return;
  document.querySelectorAll('.over, .drop-target').forEach((el) => el.classList.remove('over', 'drop-target'));
  const scope = target.closest('[data-inv-section]') ?? target;
  if (blocked.has(scope)) return dragHint(blocked.get(scope)); // no preventDefault: the browser shows "not allowed"
  dragHint(null);
  e.preventDefault();
  target.classList.add(target.matches('[data-cell]') ? 'over' : 'drop-target');
});
document.addEventListener('dragend', () => {
  dragFrom = null;
  dragItem = null;
  dragHint(null);
  for (const el of blocked.keys()) {
    el.classList.remove('no-drop');
    el.removeAttribute('title');
  }
  blocked.clear();
  document.querySelectorAll('.over, .drop-target').forEach((el) => el.classList.remove('over', 'drop-target'));
});
document.addEventListener('drop', (e) => {
  if (!dragFrom) return;
  e.preventDefault();
  const from = dragFrom;
  dragFrom = null;
  const cell = e.target.closest('[data-cell]');
  if (cell) {
    const to = { inv: cell.dataset.inv, x: Number(cell.dataset.x), y: Number(cell.dataset.y) };
    if (to.inv === from.inv && to.x === from.x && to.y === from.y) return render();
    state.slot = null;
    return applyOp({ op: 'move', from, to });
  }
  const nav = e.target.closest('[data-drop-container]');
  if (nav?.dataset.dropContainer) {
    state.slot = null;
    moveToContainer(from, nav.dataset.dropContainer);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.view?.ops) e.preventDefault();
});

loadAccounts();

document.addEventListener('change', (e) => {
  if (e.target.matches?.('input[name="kind"]')) previewType();
});
