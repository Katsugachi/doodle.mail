// doodle.mail — app shell, routing, list, wiring.
import { h, icon, clear, debounce, fmtListDate, initial, snippet, dayBucket, plural } from './util.js';
import {
  S, FOLDERS, listAccounts, currentAddress, setCurrent, loadSettings, saveSettings, applyTheme, removeAccount,
  listFor, counts, onChange, emit, patchMsgs, deleteForever, isPending, isSnoozed, displayName,
} from './state.js';
import { openDB, deleteDB } from './db.js';
import { fingerprint } from './crypto.js';
import { createTransport } from './net.js';
import { onIncoming, onDelivery } from './mail.js';
import { renderOnboard } from './ui/onboard.js';
import { openCompose, closeAllComposers } from './ui/compose.js';
import { renderReader, renderReaderEmpty, refreshReaderChrome } from './ui/reader.js';
import { renderSettings } from './ui/settings.js';
import { toast, openMenu, closeMenus, modal, emptyState } from './ui/common.js';
import * as A from './ui/actions.js';

const root = document.getElementById('root');
const ui = {};
let unsubs = [];
let tickers = [];
let readerState = { id: null, bodyKey: '', chromeKey: '' };
let lastListIds = [];

// ---------- boot ----------
async function boot() {
  const addr = currentAddress();
  if (addr && listAccounts().some(a => a.address === addr)) await startSession(addr);
  else showOnboard();
}

function showOnboard() {
  document.documentElement.dataset.density = 'default';
  renderOnboard(root, { onReady: (a) => startSession(a) });
}

async function startSession(address) {
  const acc = listAccounts().find(a => a.address === address);
  if (!acc) return showOnboard();
  root.className = 'boot';
  clear(root).appendChild(h('div', { class: 'boot-msg' }, 'opening your notebook…'));
  S.account = { ...acc };
  S.settings = loadSettings(address, acc.name);
  applyTheme();
  setCurrent(address);
  S.db = await openDB(address);
  S.identity = await S.db.kv.get('identity');
  if (!S.identity) { toast('This notebook is missing its key. Restore a backup or create a new address.'); setCurrent(null); return showOnboard(); }
  S.fingerprint = await fingerprint(S.identity.publicJwk);
  S.msgs = new Map((await S.db.messages.all()).map(m => [m.id, m]));
  S.selected = new Set();
  S.filter = 'all';
  // purge bin after 30 days
  const old = [...S.msgs.values()].filter(m => m.loc === 'bin' && m.binAt && Date.now() - m.binAt > 30 * 864e5).map(m => m.id);
  if (old.length) await deleteForever(old);
  buildShell();
  startTransport();
  wire();
  onRoute();
}

function netConfig() {
  const n = S.settings.network || {};
  const cfg = {};
  if (n.host) { cfg.host = n.host; cfg.secure = n.secure !== false; if (n.port) cfg.port = Number(n.port); if (n.path) cfg.path = n.path; }
  if (n.iceServers) { try { cfg.iceServers = JSON.parse(n.iceServers); } catch { /* validated in settings */ } }
  return Object.keys(cfg).length ? cfg : undefined;
}

function startTransport() {
  S.transport?.stop();
  if (!globalThis.peerjs?.Peer) { setStatus('error', 'PeerJS failed to load'); return; }
  S.transport = createTransport({
    address: S.account.address, name: S.account.name, identity: S.identity, config: netConfig(),
    outbox: S.db.outbox, getBlob: (id) => S.db.blobs.get(id),
    knownKeys: { get: (a) => S.db.kv.get('key:' + a), set: (a, jwk) => S.db.kv.set('key:' + a, jwk) },
    onStatus: (s, d) => setStatus(s, d),
    onMessage: (env, meta) => onIncoming(env, meta),
    onDelivery: (item, state, info) => onDelivery(item, state, info),
  });
  S.transport.start();
}

function setStatus(s, detail) {
  const prev = S.status;
  S.status = s;
  renderStatus();
  if (s === 'taken' && prev !== 'taken') {
    toast('This address is open in another tab or device, so letters are going there.', { action: 'Use this tab', timeout: 0, onAction: () => startTransport() });
  }
  if (s === 'error' && detail) console.warn('transport:', detail);
}

function stopSession() {
  unsubs.forEach(u => u()); unsubs = [];
  tickers.forEach(clearInterval); tickers = [];
  S.transport?.stop(); S.transport = null;
  closeAllComposers(); closeMenus();
  S.db?.close(); S.db = null;
  S.msgs = new Map(); S.account = null; S.settings = null; S.status = 'offline';
  document.title = 'doodle.mail';
}

async function signOut() { stopSession(); setCurrent(null); applyTheme(); showOnboard(); }
async function deleteAccount() {
  const a = S.account.address;
  stopSession();
  await deleteDB(a);
  removeAccount(a);
  toast('Account erased from this browser');
  showOnboard();
}

// ---------- shell ----------
function buildShell() {
  root.className = '';
  clear(root);
  ui.search = h('input', { type: 'search', placeholder: 'Search mail, people, or anything…', 'aria-label': 'Search mail', autocomplete: 'off', spellcheck: 'false' });
  ui.avatar = h('button', { class: 'avatar-btn', 'aria-label': 'Account menu', 'data-menu-anchor': '', onclick: (e) => accountMenu(e.currentTarget) });
  ui.themeBtn = h('button', { class: 'icon-btn hide-sm', title: 'Toggle light/dark', 'aria-label': 'Toggle theme', onclick: () => {
    const cur = document.documentElement.dataset.theme;
    S.settings.theme = cur === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); renderThemeBtn();
  } });
  ui.nav = h('nav', { class: 'nav', 'aria-label': 'Folders' });
  ui.labels = h('div', { class: 'nav', 'aria-label': 'Labels' });
  ui.sidebar = h('aside', { class: 'sidebar' },
    h('button', { class: 'compose-btn', onclick: () => { closeDrawer(); openCompose(); } }, icon('pencil'), 'Compose'),
    h('div', { class: 'side-scroll' }, ui.nav, h('div', { class: 'side-sep' }),
      h('div', { class: 'labels-head' }, h('span', null, 'Labels'), h('button', { class: 'icon-btn sm', title: 'New label', 'aria-label': 'New label', onclick: async () => {
        const { promptDialog } = await import('./ui/common.js');
        const n = await promptDialog('New label', 'Label name', '', { iconName: 'label', okLabel: 'Create' });
        if (n) A.createLabel(n);
      } }, icon('plus'))), ui.labels));
  ui.main = h('main', { class: 'main' });
  ui.app = h('div', { class: 'app' },
    h('a', { class: 'brand', href: '#/f/inbox', 'aria-label': 'doodle.mail inbox' }, icon('logo'), h('span', { class: 'brand-name' }, 'doodle.mail')),
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn menu-toggle', 'aria-label': 'Open menu', onclick: () => ui.app.classList.toggle('drawer-open') }, icon('menu')),
      h('form', { class: 'search', role: 'search', onsubmit: (e) => { e.preventDefault(); doSearch(ui.search.value, true); } },
        icon('search'), ui.search,
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Search options', 'aria-label': 'Search options', 'data-menu-anchor': '', onclick: (e) => advancedSearch(e.currentTarget) }, icon('sliders'))),
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn hide-sm', title: 'Help & shortcuts (?)', 'aria-label': 'Help', onclick: showHelp }, icon('help')),
        h('a', { class: 'icon-btn', href: '#/settings/general', title: 'Settings', 'aria-label': 'Settings' }, icon('gear')),
        ui.themeBtn, ui.avatar)),
    ui.sidebar, ui.main, h('div', { class: 'scrim', onclick: closeDrawer }));
  root.appendChild(ui.app);
  ui.search.addEventListener('input', debounce(() => doSearch(ui.search.value, false), 280));
  renderThemeBtn();
  renderAvatar();
  renderStatus();
  renderSidebar();
}

function closeDrawer() { ui.app?.classList.remove('drawer-open'); }
function renderThemeBtn() { clear(ui.themeBtn).appendChild(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')); }
function renderAvatar() {
  clear(ui.avatar).append(h('span', { class: 'avatar me' }, initial(S.account.name, S.account.address)), icon('chevronDown'));
}
function renderStatus() {
  if (!ui.status) return;
  const txt = { online: 'online', connecting: 'connecting…', offline: 'offline', taken: 'open elsewhere', error: 'network error' }[S.status] || S.status;
  ui.status.className = `status-pill ${S.status}`;
  ui.status.title = S.status === 'online' ? `Reachable as ${S.account.address}@doodle.mail` : 'Letters will queue in the Outbox until you are back online';
  clear(ui.status).append(h('i'), h('span', { class: 'txt' }, txt));
}

let showMore = false;
function renderSidebar() {
  const c = counts();
  const r = S.route;
  clear(ui.nav);
  const item = (f) => {
    const active = r.view === 'folder' && r.folder === f.id;
    let cnt = null;
    if (f.id === 'inbox' && c.inbox) cnt = h('span', { class: 'cnt badge' }, String(c.inbox));
    else if (f.id === 'drafts' && c.drafts) cnt = h('span', { class: 'cnt' }, String(c.drafts));
    else if (f.id === 'outbox' && c.outbox) cnt = h('span', { class: 'cnt' }, String(c.outbox));
    else if (f.id === 'spam' && c.spam) cnt = h('span', { class: 'cnt' }, String(c.spam));
    else if (f.id === 'snoozed' && c.snoozed) cnt = h('span', { class: 'cnt' }, String(c.snoozed));
    return h('a', { class: 'nav-item' + (active ? ' active' : ''), href: `#/f/${f.id}`, 'aria-current': active ? 'page' : null, onclick: closeDrawer }, icon(f.icon), h('span', null, f.name), cnt);
  };
  const activeMore = FOLDERS.some(f => f.more && r.view === 'folder' && r.folder === f.id);
  FOLDERS.filter(f => !f.more && (f.id !== 'outbox' || c.outbox || (r.view === 'folder' && r.folder === 'outbox'))).forEach(f => ui.nav.appendChild(item(f)));
  if (showMore || activeMore) FOLDERS.filter(f => f.more).forEach(f => ui.nav.appendChild(item(f)));
  ui.nav.appendChild(h('button', { class: 'nav-item', 'aria-expanded': String(showMore || activeMore), onclick: () => { showMore = !showMore; renderSidebar(); } },
    icon(showMore || activeMore ? 'chevronUp' : 'more'), h('span', null, showMore || activeMore ? 'Less' : 'More')));
  clear(ui.labels);
  S.settings.labels.forEach(l => {
    const active = r.view === 'label' && r.labelId === l.id;
    ui.labels.appendChild(h('a', { class: 'nav-item label-item' + (active ? ' active' : ''), href: `#/l/${l.id}`, onclick: closeDrawer }, icon('label'), h('span', null, l.name), c.labels[l.id] ? h('span', { class: 'cnt' }, String(c.labels[l.id])) : null));
  });
  if (!S.settings.labels.length) ui.labels.appendChild(h('div', { class: 'storage-note' }, 'No labels yet — add one with +'));
  document.title = c.inbox ? `(${c.inbox}) doodle.mail` : 'doodle.mail';
}

// ---------- routing ----------
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const r = { view: 'folder', folder: 'inbox', msgId: null };
  if (parts[0] === 'settings') return { view: 'settings', tab: parts[1] || 'general' };
  if (parts[0] === 'l' && parts[1]) { r.view = 'label'; r.labelId = parts[1]; }
  else if (parts[0] === 'search') { r.view = 'search'; r.query = parts[1] || ''; }
  else if (parts[0] === 'f' && FOLDERS.some(f => f.id === parts[1])) r.folder = parts[1];
  const mi = parts.indexOf('m');
  if (mi > 0 && parts[mi + 1]) r.msgId = parts[mi + 1];
  return r;
}
function baseHash(r = S.route) {
  if (r.view === 'label') return `#/l/${encodeURIComponent(r.labelId)}`;
  if (r.view === 'search') return `#/search/${encodeURIComponent(r.query || '')}`;
  return `#/f/${r.folder}`;
}
function sameList(a, b) { return a.view === b.view && a.folder === b.folder && a.labelId === b.labelId && a.query === b.query; }

function onRoute() {
  if (!S.account) return;
  const prev = S.route;
  const r = parseHash();
  if (r.view === 'label' && !S.settings.labels.some(l => l.id === r.labelId)) { location.hash = '#/f/inbox'; return; }
  if (!sameList(prev, r)) { S.selected.clear(); S.filter = 'all'; }
  S.route = r;
  if (r.view !== 'search' && document.activeElement !== ui.search) ui.search.value = '';
  if (r.view === 'search' && document.activeElement !== ui.search) ui.search.value = r.query;
  closeMenus();
  renderSidebar();
  renderMain(true);
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else onRoute(); }

function doSearch(q, commit) {
  q = q.trim();
  if (!q) { if (S.route.view === 'search') go('#/f/inbox'); return; }
  const hsh = `#/search/${encodeURIComponent(q)}`;
  if (commit) go(hsh); else history.replaceState(null, '', hsh), onRoute();
}

// ---------- main area ----------
function renderMain(routeChanged) {
  const r = S.route;
  if (r.view === 'settings') {
    ui.main.className = 'main single';
    if (routeChanged || !ui.settingsPane?.isConnected) {
      clear(ui.main);
      ui.settingsPane = h('section', { class: 'settings-pane sketch' });
      ui.main.appendChild(ui.settingsPane);
      renderSettings(ui.settingsPane, r.tab, { reconnect: startTransport, signOut, deleteAccount });
    }
    readerState = { id: null };
    return;
  }
  if (!ui.listPane?.isConnected) {
    clear(ui.main);
    ui.listPane = h('section', { class: 'list-pane sketch', 'aria-label': 'Letters' });
    ui.readerPane = h('section', { class: 'reader-pane sketch', 'aria-label': 'Reading pane' });
    ui.main.append(ui.listPane, ui.readerPane);
    readerState = { id: null };
  }
  ui.main.className = 'main' + (r.msgId ? ' has-reader' : '');
  renderList(routeChanged);
  renderReaderPane(routeChanged);
}

function readerKeys(id) {
  const m = S.msgs.get(id);
  if (!m) return { bodyKey: 'none', chromeKey: 'none' };
  const conv = [...S.msgs.values()].filter(x => x.threadId === m.threadId && !x.draft);
  const bodyKey = conv.map(x => `${x.id}|${x.loc}|${JSON.stringify(x.delivery || {})}`).sort().join(';');
  const chromeKey = `${m.starred}|${m.important}|${(m.labels || []).join(',')}|${m.snoozeUntil}|${m.read}|${m.loc}|${S.settings.labels.map(l => l.name).join()}`;
  return { bodyKey, chromeKey };
}

function renderReaderPane(force) {
  const id = S.route.msgId;
  if (!id) { if (force || readerState.id) { renderReaderEmpty(ui.readerPane); readerState = { id: null }; } return; }
  const k = readerKeys(id);
  if (!force && readerState.id === id && readerState.bodyKey === k.bodyKey) {
    if (readerState.chromeKey !== k.chromeKey) { refreshReaderChrome(ui.readerPane, id, { onBack: backToList }); readerState.chromeKey = k.chromeKey; }
    return;
  }
  if (!force && readerState.id === id) {
    // body changed (e.g. a reply arrived) — rerender but keep scroll + quick reply text
    const sc = ui.readerPane.querySelector('.reader-scroll')?.scrollTop || 0;
    const qr = ui.readerPane.querySelector('.quick-reply textarea')?.value || '';
    renderReader(ui.readerPane, id, { onBack: backToList });
    const s2 = ui.readerPane.querySelector('.reader-scroll'); if (s2) s2.scrollTop = sc;
    const t2 = ui.readerPane.querySelector('.quick-reply textarea'); if (t2) t2.value = qr;
  } else {
    renderReader(ui.readerPane, id, { onBack: backToList });
  }
  readerState = { id, ...k };
}

function backToList() { go(baseHash()); }

const FILTERS = [
  ['all', 'All'], ['unread', 'Unread'], ['starred', 'Starred'], ['important', 'Important'], ['files', 'Files'],
];
const passFilter = (m) => S.filter === 'all' || (S.filter === 'unread' && !m.read) || (S.filter === 'starred' && m.starred) || (S.filter === 'important' && m.important) || (S.filter === 'files' && m.attachments?.length);

function listTitle() {
  const r = S.route;
  if (r.view === 'search') return [`Search`, `“${r.query}”`];
  if (r.view === 'label') return [S.settings.labels.find(l => l.id === r.labelId)?.name || 'Label', null];
  return [FOLDERS.find(f => f.id === r.folder)?.name || 'Inbox', null];
}

function renderList(routeChanged) {
  const pane = ui.listPane;
  const prevScroll = pane.querySelector('.list-scroll')?.scrollTop || 0;
  clear(pane);
  const base = listFor(S.route);
  const unread = base.filter(m => !m.read).length;
  const list = base.filter(passFilter);
  lastListIds = list.map(m => m.id);
  for (const id of [...S.selected]) if (!S.msgs.has(id)) S.selected.delete(id);

  const headEl = h('div', { class: 'list-head' });
  if (S.selected.size) {
    const ids = [...S.selected];
    const allSel = list.length && list.every(m => S.selected.has(m.id));
    const r = S.route;
    const inBin = r.view === 'folder' && r.folder === 'bin';
    const inSpam = r.view === 'folder' && r.folder === 'spam';
    const b = (ic, label, fn) => h('button', { class: 'icon-btn', title: label, 'aria-label': label, 'data-menu-anchor': '', onclick: fn }, icon(ic));
    headEl.appendChild(h('div', { class: 'bulkbar' },
      b(allSel ? 'select' : 'x', allSel ? 'Clear selection' : 'Select all', () => { if (allSel) S.selected.clear(); else list.forEach(m => S.selected.add(m.id)); renderList(); }),
      h('span', { class: 'cnt' }, `${ids.length} selected`),
      b('mailOpen', 'Mark read', async () => { await A.setRead(ids, true); }),
      b('mail', 'Mark unread', async () => { await A.setRead(ids, false); }),
      b('star', 'Star', () => A.toggleStar(ids, !ids.every(id => S.msgs.get(id)?.starred))),
      b('label', 'Label', (e) => A.labelMenu(e.currentTarget, ids)),
      !inBin ? b('clock', 'Snooze', (e) => A.snoozeMenu(e.currentTarget, ids)) : null,
      !inBin && !inSpam ? b('archive', 'Archive', async () => { await A.archive(ids); S.selected.clear(); }) : null,
      inSpam ? b('inbox', 'Not spam', async () => { await A.moveToInbox(ids); S.selected.clear(); }) : (!inBin ? b('spam', 'Report spam', async () => { await A.markSpam(ids); S.selected.clear(); }) : null),
      inBin ? b('restore', 'Restore', async () => { await A.restore(ids); S.selected.clear(); }) : null,
      inBin ? b('trash', 'Delete forever', async () => { if (await A.forever(ids)) { S.selected.clear(); renderList(); } }) : b('trash', 'Move to Bin', async () => { await A.toBin(ids); S.selected.clear(); }),
      h('span', { style: { flex: 1 } }),
      b('x', 'Clear selection', () => { S.selected.clear(); renderList(); })));
  } else {
    headEl.appendChild(h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Filters' }, FILTERS.map(([id, name]) =>
      h('button', { class: 'chip' + (S.filter === id ? ' on' : ''), 'aria-pressed': String(S.filter === id), onclick: () => { S.filter = id; renderList(); } },
        name, id === 'unread' && unread ? h('span', { class: 'count' }, String(unread)) : null))));
    headEl.appendChild(h('button', { class: 'icon-btn', title: 'List options', 'aria-label': 'List options', 'data-menu-anchor': '', onclick: (e) => listMenu(e.currentTarget, base) }, icon('chevronDown')));
  }
  const [t, sub] = listTitle();
  const titleEl = h('div', { class: 'list-title' }, h('span', null, t), sub ? h('span', null, sub) : null, h('span', { class: 'muted' }, `${plural(list.length, 'letter')}${unread ? ` · ${unread} unread` : ''}`));
  const r = S.route;
  if (r.view === 'folder' && (r.folder === 'bin' || r.folder === 'spam') && base.length) {
    titleEl.appendChild(h('button', { class: 'link-btn', style: { marginLeft: 'auto', fontSize: '15px' }, onclick: () => A.emptyFolder(r.folder) }, r.folder === 'bin' ? 'Empty bin' : 'Delete all spam'));
  }
  if (r.view === 'folder' && r.folder === 'outbox' && base.length) {
    titleEl.appendChild(h('button', { class: 'link-btn', style: { marginLeft: 'auto', fontSize: '15px' }, onclick: () => { S.transport?.retryNow(); toast('Retrying deliveries…'); } }, 'Retry all now'));
  }
  const scroll = h('div', { class: 'list-scroll', role: 'list' });
  if (!list.length) scroll.appendChild(emptyFor(r));
  let bucket = null;
  for (const m of list) {
    const b = dayBucket(m.sortDate || m.date);
    if (b !== bucket) { bucket = b; scroll.appendChild(h('div', { class: 'group-label' }, b)); }
    scroll.appendChild(rowFor(m));
  }
  pane.append(headEl, titleEl, scroll);
  if (!routeChanged) scroll.scrollTop = prevScroll;
  const active = scroll.querySelector('.row.active');
  if (routeChanged && active) active.scrollIntoView({ block: 'nearest' });
}

function emptyFor(r) {
  if (r.view === 'search') return emptyState('search', 'Nothing matches', 'Try from:name, to:name, has:attachment, is:unread or label:work');
  const map = {
    inbox: ['inbox', 'Inbox zero!', 'Have a biscuit. Share your address so friends can write.'],
    sent: ['sent', 'No letters sent yet', 'Press c to write one.'],
    outbox: ['sent', 'Outbox is empty', 'Everything has been delivered.'],
    drafts: ['inbox', 'No drafts', 'Half-written letters show up here.'],
    starred: ['inbox', 'Nothing starred', 'Star letters to find them quickly.'],
    snoozed: ['inbox', 'Nothing snoozed', 'Snoozed letters come back when you want them.'],
    spam: ['inbox', 'No spam', 'Hooray.'],
    bin: ['inbox', 'Bin is empty', 'Deleted letters stay here for 30 days.'],
  };
  const [d, big, small] = map[r.folder] || ['inbox', 'Nothing here yet', null];
  return emptyState(d, big, small);
}

function rowFor(m) {
  const r = S.route;
  const out = m.dir === 'out';
  const selected = S.selected.has(m.id);
  const name = out ? 'To: ' + ([...m.to, ...m.cc].map(a => displayName(a)).join(', ') || '(no recipients)') : (m.from.name || m.from.address);
  const tags = [];
  if (m.draft) tags.push(h('span', { class: 'mini-tag solid' }, 'draft'));
  if (!m.draft && isPending(m)) tags.push(h('span', { class: 'mini-tag', title: 'Waiting for the recipient to come online' }, 'queued'));
  if (isSnoozed(m) && !(r.view === 'folder' && r.folder === 'snoozed')) tags.push(h('span', { class: 'mini-tag' }, 'snoozed'));
  if (m.loc === 'spam' && r.folder !== 'spam') tags.push(h('span', { class: 'mini-tag' }, 'spam'));
  (m.labels || []).slice(0, 2).forEach(l => { const lab = S.settings.labels.find(x => x.id === l); if (lab && !(r.view === 'label' && r.labelId === l)) tags.push(h('span', { class: 'mini-tag' }, lab.name)); });
  const avatar = h('button', { class: 'avatar' + (selected ? ' selected' : ''), 'aria-label': selected ? 'Deselect' : 'Select', 'aria-pressed': String(selected), onclick: (e) => {
    e.stopPropagation();
    if (S.selected.has(m.id)) S.selected.delete(m.id); else S.selected.add(m.id);
    renderList();
  } }, selected ? icon('check') : initial(out ? displayName(m.to[0] || '') : (m.from.name || m.from.address), ''));
  const star = h('button', { class: 'icon-btn', 'aria-label': m.starred ? 'Unstar' : 'Star', title: m.starred ? 'Starred' : 'Star', onclick: (e) => { e.stopPropagation(); A.toggleStar([m.id]); } }, icon(m.starred ? 'starFill' : 'star'));
  const imp = m.important ? h('span', { class: 'icon-btn', title: 'Important' }, icon('importantFill')) : null;
  const el = h('div', {
    class: `row${!m.read ? ' unread' : ''}${r.msgId === m.id ? ' active' : ''}${selected ? ' checked' : ''}`, role: 'listitem', tabindex: '0', dataset: { id: m.id },
    onclick: () => openItem(m),
    onkeydown: (e) => { if (e.key === 'Enter') openItem(m); },
  },
    !m.read ? h('span', { class: 'unread-dot', 'aria-label': 'unread' }) : h('span'),
    avatar,
    h('div', { class: 'row-main' },
      h('div', { class: 'row-from' }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, name), tags.length ? h('span', { class: 'mini-tags' }, tags) : null),
      h('div', { class: 'row-subject' }, m.subject || '(no subject)'),
      h('div', { class: 'row-snip' }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, snippet(m.text) || '—'), m.attachments?.length ? icon('clip') : null)),
    h('div', { class: 'row-side' }, h('span', { class: 'row-date' }, fmtListDate(m.sortDate || m.date)), h('span', { class: 'row-icons' }, imp, star)));
  return el;
}

function openItem(m) {
  if (m.draft) { openCompose({ draftId: m.id }); return; }
  go(`${baseHash()}/m/${encodeURIComponent(m.id)}`);
}

function listMenu(anchor, base) {
  const r = S.route;
  const unreadIds = base.filter(m => !m.read).map(m => m.id);
  openMenu(anchor, [
    { label: 'Mark all as read', icon: 'mailOpen', disabled: !unreadIds.length, onClick: async () => { await A.setRead(unreadIds, true); toast(`${plural(unreadIds.length, 'letter')} marked as read`); } },
    { label: 'Select all', icon: 'select', disabled: !base.length, onClick: () => { base.filter(passFilter).forEach(m => S.selected.add(m.id)); renderList(); } },
    'sep', { head: 'Density' },
    ...[['comfortable', 'Comfortable'], ['default', 'Default'], ['compact', 'Compact']].map(([id, n]) => ({ label: n, icon: S.settings.density === id ? 'check' : 'density', onClick: () => { S.settings.density = id; saveSettings(); applyTheme(); } })),
    r.view === 'folder' && (r.folder === 'bin' || r.folder === 'spam') ? 'sep' : null,
    r.view === 'folder' && r.folder === 'bin' ? { label: 'Empty bin', icon: 'trash', onClick: () => A.emptyFolder('bin') } : null,
    r.view === 'folder' && r.folder === 'spam' ? { label: 'Delete all spam', icon: 'trash', onClick: () => A.emptyFolder('spam') } : null,
  ]);
}

function advancedSearch(anchor) {
  const f = (label, ph) => { const i = h('input', { class: 'input', placeholder: ph }); return [h('div', { class: 'menu-head' }, label), i]; };
  const [l1, from] = f('From', 'maya'); const [l2, to] = f('To', 'james'); const [l3, subj] = f('Subject', 'lunch'); const [l4, words] = f('Has the words', 'onboarding');
  const att = h('input', { type: 'checkbox' }); const unr = h('input', { type: 'checkbox' });
  const run = () => {
    const q = [from.value && `from:${from.value.trim()}`, to.value && `to:${to.value.trim()}`, subj.value && `subject:"${subj.value.trim()}"`, words.value.trim(), att.checked && 'has:attachment', unr.checked && 'is:unread'].filter(Boolean).join(' ');
    closeMenus(); ui.search.value = q; doSearch(q, true);
  };
  const box = h('div', { style: { display: 'grid', gap: '2px', padding: '4px 6px' } }, l1, from, l2, to, l3, subj, l4, words,
    h('label', { class: 'check', style: { margin: '8px 4px 2px' } }, att, h('span', null, 'Has attachment')),
    h('label', { class: 'check', style: { margin: '4px 4px 8px' } }, unr, h('span', null, 'Unread only')),
    h('button', { class: 'btn sm primary', onclick: run }, icon('search'), 'Search'));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  openMenu(anchor, [box], { width: 300 });
}

function accountMenu(anchor) {
  const others = listAccounts().filter(a => a.address !== S.account.address);
  openMenu(anchor, [
    h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', padding: '8px 12px 10px' } },
      h('span', { class: 'avatar lg' }, initial(S.account.name)),
      h('div', { style: { minWidth: 0 } }, h('div', { style: { fontSize: '20px' } }, S.account.name), h('div', { class: 'hint' }, `${S.account.address}@doodle.mail`))),
    { label: 'Copy my address', icon: 'copy', onClick: () => navigator.clipboard?.writeText(`${S.account.address}@doodle.mail`).then(() => toast('Address copied — share it with a friend')) },
    { label: 'Account & backup', icon: 'user', onClick: () => go('#/settings/account') },
    { label: 'Appearance', icon: 'palette', onClick: () => go('#/settings/appearance') },
    'sep',
    ...others.map(a => ({ label: `Switch to ${a.address}`, icon: 'refresh', onClick: async () => { stopSession(); await startSession(a.address); } })),
    { label: 'Add another address', icon: 'plus', onClick: signOut },
    { label: 'Sign out', icon: 'logout', onClick: signOut },
  ], { width: 300 });
}

function showHelp() {
  const sc = [['c', 'Compose'], ['/', 'Search'], ['j / k', 'Next / previous letter'], ['Enter', 'Open'], ['u', 'Back to list'], ['e', 'Archive'], ['#', 'Move to Bin'], ['s', 'Star'], ['!', 'Mark important'], ['r / a / f', 'Reply / all / forward'], ['Shift+U', 'Mark unread'], ['Shift+I', 'Mark read'], ['x', 'Select'], ['g i', 'Go to Inbox'], ['Ctrl+Enter', 'Send (in compose)'], ['?', 'This help']];
  modal({
    title: 'Help & shortcuts', iconName: 'help', wide: true,
    body: [
      h('div', { class: 'terms-text' },
        h('p', null, `You are ${S.account.address}@doodle.mail. Share that address; anyone using doodle.mail can write to you.`),
        h('p', null, 'Letters go directly browser-to-browser. If a friend is offline, your letter waits in the Outbox and is delivered automatically when you are both online. Everything is stored only in this browser — export a backup in Settings → Account.')),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px 18px' } },
        sc.map(([k, d]) => h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('span', { class: 'kbd' }, k), h('span', null, d)))),
    ],
    actions: [{ label: 'Got it', primary: true }],
  });
}

// ---------- events ----------
function wire() {
  unsubs.push(onChange((kind) => {
    if (!S.account) return;
    if (kind === 'msgs' || kind === 'settings' || kind === 'snoozed') { renderSidebar(); if (S.route.view !== 'settings') renderMain(false); }
    if (kind === 'settings') renderThemeBtn();
    if (kind === 'account') renderAvatar();
    if (kind.startsWith('incoming:')) {
      const m = S.msgs.get(kind.slice(9));
      renderSidebar(); if (S.route.view !== 'settings') renderMain(false);
      if (!m || m.loc !== 'inbox') return;
      toast(`New letter from ${m.from.name || m.from.address}`, { action: 'Open', onAction: () => go(`#/f/inbox/m/${m.id}`) });
      if (S.settings.notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { const n = new Notification(m.from.name || m.from.address, { body: m.subject, tag: m.id, icon: 'favicon.svg' }); n.onclick = () => { focus(); go(`#/f/inbox/m/${m.id}`); n.close(); }; } catch { /* ignore */ }
      }
    }
    if (kind.startsWith('delivered:')) toast(`Delivered to ${kind.slice(10)}`, { timeout: 2500 });
  }));
  tickers.push(setInterval(async () => {
    const due = [...S.msgs.values()].filter(m => m.snoozeUntil && m.snoozeUntil <= Date.now());
    if (due.length) { await patchMsgs(due.map(m => m.id), { snoozeUntil: null, sortDate: Date.now(), read: false }); toast(`${plural(due.length, 'snoozed letter')} back in your inbox`); }
  }, 15000));
  tickers.push(setInterval(() => { if (S.route.view !== 'settings' && !document.hidden) renderList(false); }, 60000));
}

window.addEventListener('hashchange', onRoute);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!S.settings || S.settings.theme === 'system') { applyTheme(); if (ui.themeBtn) renderThemeBtn(); } });
window.addEventListener('storage', (e) => { if (S.account && e.key === `doodlemail:settings:${S.account.address}`) { S.settings = loadSettings(S.account.address, S.account.name); applyTheme(); emit('settings'); } });

let gPending = false;
document.addEventListener('keydown', (e) => {
  if (!S.account || !S.settings?.shortcuts) return;
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable], .compose, .overlay, .menu')) return;
  const id = S.route.msgId;
  const cur = id ? S.msgs.get(id) : null;
  const focusRow = document.activeElement?.closest?.('.row')?.dataset.id;
  const k = e.key;
  if (gPending) {
    gPending = false;
    const dest = { i: 'inbox', s: 'starred', t: 'sent', d: 'drafts', a: 'all', b: 'bin' }[k];
    if (dest) { e.preventDefault(); go(`#/f/${dest}`); }
    return;
  }
  const move = (d) => {
    if (!lastListIds.length) return;
    const ref = id || focusRow;
    let i = ref ? lastListIds.indexOf(ref) : -1;
    i = Math.max(0, Math.min(lastListIds.length - 1, i + d));
    const m = S.msgs.get(lastListIds[i]);
    if (!m) return;
    if (id) openItem(m); else document.querySelector(`.row[data-id="${CSS.escape(m.id)}"]`)?.focus();
  };
  const targetIds = S.selected.size ? [...S.selected] : (cur ? [cur.id] : focusRow ? [focusRow] : []);
  const acts = {
    c: () => openCompose(),
    '/': () => ui.search.focus(),
    '?': showHelp,
    j: () => move(1), k: () => move(-1),
    u: () => id && backToList(),
    g: () => { gPending = true; setTimeout(() => { gPending = false; }, 1200); },
    s: () => targetIds.length && A.toggleStar(targetIds),
    '!': () => targetIds.length && A.toggleImportant(targetIds),
    e: async () => { if (targetIds.length) { await A.archive(targetIds); S.selected.clear(); if (id) backToList(); } },
    '#': async () => { if (targetIds.length) { await A.toBin(targetIds); S.selected.clear(); if (id) backToList(); } },
    Delete: async () => { if (targetIds.length) { await A.toBin(targetIds); S.selected.clear(); if (id) backToList(); } },
    U: () => targetIds.length && A.setRead(targetIds, false),
    I: () => targetIds.length && A.setRead(targetIds, true),
    x: () => { const fid = focusRow || id; if (fid) { S.selected.has(fid) ? S.selected.delete(fid) : S.selected.add(fid); renderList(); } },
    Escape: () => { if (S.selected.size) { S.selected.clear(); renderList(); } else if (id) backToList(); },
  };
  if (cur) Object.assign(acts, {
    r: () => import('./mail.js').then(M => openCompose({ ...M.replyInit(cur, 'reply'), focus: 'body' })),
    a: () => import('./mail.js').then(M => openCompose({ ...M.replyInit(cur, 'replyAll'), focus: 'body' })),
    f: () => import('./mail.js').then(M => openCompose(M.replyInit(cur, 'forward'))),
  });
  const fn = acts[k];
  if (fn) { e.preventDefault(); fn(); }
});

boot().catch((err) => {
  console.error(err);
  clear(root).appendChild(h('div', { class: 'boot-msg' }, 'Something went wrong opening your notebook: ' + (err?.message || err)));
});
