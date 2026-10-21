// App state, accounts, settings and message bookkeeping.
import { uuid } from './util.js';

export const S = {
  account: null,      // {address, name, createdAt}
  settings: null,
  db: null,
  transport: null,
  identity: null,
  fingerprint: '',
  msgs: new Map(),
  status: 'offline',
  route: { view: 'folder', folder: 'inbox' },
  filter: 'all',
  selected: new Set(),
};

const LS = {
  accounts: 'doodlemail:accounts',
  current: 'doodlemail:current',
  settings: (a) => `doodlemail:settings:${a}`,
};

export function listAccounts() {
  try { return JSON.parse(localStorage.getItem(LS.accounts) || '[]'); } catch { return []; }
}
export function saveAccounts(list) { localStorage.setItem(LS.accounts, JSON.stringify(list)); }
export function currentAddress() { return localStorage.getItem(LS.current); }
export function setCurrent(address) {
  if (address) localStorage.setItem(LS.current, address); else localStorage.removeItem(LS.current);
}
export function upsertAccount(acc) {
  const list = listAccounts().filter(a => a.address !== acc.address);
  list.push(acc);
  saveAccounts(list);
}
export function removeAccount(address) {
  saveAccounts(listAccounts().filter(a => a.address !== address));
  localStorage.removeItem(LS.settings(address));
  if (currentAddress() === address) setCurrent(null);
}

export function defaultSettings(name) {
  const sigId = uuid();
  return {
    theme: 'system',
    density: 'default',
    signatures: [{ id: sigId, name: 'Default', text: `- ${name || ''}`.trim() }],
    sigNew: sigId,
    sigReply: sigId,
    labels: ['Work', 'Personal', 'Ideas', 'Later', 'Fun'].map(n => ({ id: uuid(), name: n })),
    blocked: [],
    strangersToSpam: false,
    autoMarkRead: true,
    undoSeconds: 5,
    notifications: false,
    shortcuts: true,
    network: { host: '', port: '', path: '', secure: true, iceServers: '' },
  };
}

export function loadSettings(address, name) {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS.settings(address)) || '{}'); } catch { /* ignore */ }
  const d = defaultSettings(name);
  return { ...d, ...s, network: { ...d.network, ...(s.network || {}) } };
}
export function saveSettings() {
  localStorage.setItem(LS.settings(S.account.address), JSON.stringify(S.settings));
}

export function applyTheme() {
  let t = S.settings?.theme || 'system';
  if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.density = S.settings?.density || 'default';
}

// ---------- messages ----------
export const FOLDERS = [
  { id: 'inbox', name: 'Inbox', icon: 'inbox' },
  { id: 'starred', name: 'Starred', icon: 'star' },
  { id: 'snoozed', name: 'Snoozed', icon: 'clock' },
  { id: 'important', name: 'Important', icon: 'important' },
  { id: 'sent', name: 'Sent', icon: 'send' },
  { id: 'outbox', name: 'Outbox', icon: 'outbox' },
  { id: 'drafts', name: 'Drafts', icon: 'draft' },
  { id: 'all', name: 'All Mail', icon: 'mail' },
  { id: 'spam', name: 'Spam', icon: 'spam', more: true },
  { id: 'bin', name: 'Bin', icon: 'trash', more: true },
];

const live = (m) => m.loc !== 'bin' && m.loc !== 'spam';
export const isSnoozed = (m) => !!m.snoozeUntil && m.snoozeUntil > Date.now();
export const isPending = (m) => m.dir === 'out' && !m.draft && Object.values(m.delivery || {}).some(d => d.state === 'queued' || d.state === 'sending');

export function inFolder(m, folder) {
  switch (folder) {
    case 'inbox': return m.loc === 'inbox' && !m.draft && !isSnoozed(m);
    case 'starred': return m.starred && live(m) && !m.draft;
    case 'snoozed': return isSnoozed(m) && m.loc !== 'bin';
    case 'important': return m.important && live(m) && !m.draft;
    case 'sent': return m.dir === 'out' && !m.draft && live(m);
    case 'outbox': return isPending(m) && m.loc !== 'bin';
    case 'drafts': return m.draft && m.loc !== 'bin';
    case 'all': return live(m) && !m.draft;
    case 'spam': return m.loc === 'spam';
    case 'bin': return m.loc === 'bin';
    default: return false;
  }
}

export function inLabel(m, labelId) { return (m.labels || []).includes(labelId) && live(m) && !m.draft; }

export function matchesSearch(m, q) {
  if (m.loc === 'bin') return false;
  const tokens = q.toLowerCase().match(/(\w+:"[^"]*"|\w+:\S+|"[^"]*"|\S+)/g) || [];
  const hay = [m.from?.name, m.from?.address, ...(m.to || []), ...(m.cc || []), m.subject, m.text, ...(m.attachments || []).map(a => a.name)]
    .filter(Boolean).join(' \n ').toLowerCase();
  for (let t of tokens) {
    const op = t.match(/^(\w+):(.*)$/);
    if (op) {
      const [, k, raw] = op;
      const v = raw.replace(/^"|"$/g, '');
      if (k === 'from') { if (!((m.from?.address || '') + ' ' + (m.from?.name || '')).toLowerCase().includes(v)) return false; continue; }
      if (k === 'to') { if (![...(m.to || []), ...(m.cc || []), ...(m.bcc || [])].some(a => a.includes(v))) return false; continue; }
      if (k === 'subject') { if (!(m.subject || '').toLowerCase().includes(v)) return false; continue; }
      if (k === 'has' && /^attach/.test(v)) { if (!(m.attachments || []).length) return false; continue; }
      if (k === 'has' && v === 'html') { if (!(m.attachments || []).some(a => /\.html?$/i.test(a.name))) return false; continue; }
      if (k === 'is') {
        if (v === 'unread' && m.read) return false;
        if (v === 'read' && !m.read) return false;
        if (v === 'starred' && !m.starred) return false;
        if (v === 'important' && !m.important) return false;
        if (v === 'draft' && !m.draft) return false;
        continue;
      }
      if (k === 'label') {
        const lab = S.settings.labels.find(l => l.name.toLowerCase() === v);
        if (!lab || !(m.labels || []).includes(lab.id)) return false;
        continue;
      }
    }
    t = t.replace(/^"|"$/g, '');
    if (t && !hay.includes(t)) return false;
  }
  return true;
}

export function listFor(route) {
  const all = [...S.msgs.values()];
  let out;
  if (route.view === 'search') out = all.filter(m => matchesSearch(m, route.query || ''));
  else if (route.view === 'label') out = all.filter(m => inLabel(m, route.labelId));
  else out = all.filter(m => inFolder(m, route.folder));
  return out.sort((a, b) => (b.sortDate || b.date) - (a.sortDate || a.date));
}

export function counts() {
  const c = { inbox: 0, drafts: 0, spam: 0, outbox: 0, snoozed: 0, labels: {} };
  for (const m of S.msgs.values()) {
    if (inFolder(m, 'inbox') && !m.read) c.inbox++;
    if (inFolder(m, 'drafts')) c.drafts++;
    if (inFolder(m, 'spam') && !m.read) c.spam++;
    if (inFolder(m, 'outbox')) c.outbox++;
    if (inFolder(m, 'snoozed')) c.snoozed++;
    for (const l of m.labels || []) if (inLabel(m, l)) c.labels[l] = (c.labels[l] || 0) + 1;
  }
  return c;
}

const subs = new Set();
export function onChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export function emit(kind) { subs.forEach(fn => fn(kind)); }

export async function saveMsg(m, { quiet } = {}) {
  S.msgs.set(m.id, m);
  await S.db.messages.put(m);
  if (!quiet) emit('msgs');
  return m;
}

export async function patchMsgs(ids, patch) {
  const recs = [];
  for (const id of ids) {
    const m = S.msgs.get(id);
    if (!m) continue;
    const p = typeof patch === 'function' ? patch(m) : patch;
    if (!p) continue;
    Object.assign(m, p);
    recs.push(m);
  }
  if (recs.length) await S.db.messages.bulkPut(recs);
  emit('msgs');
  return recs;
}

export async function deleteForever(ids) {
  const inUse = new Set();
  const gone = new Set(ids);
  for (const m of S.msgs.values()) if (!gone.has(m.id)) for (const a of m.attachments || []) inUse.add(a.id);
  for (const id of ids) {
    const m = S.msgs.get(id);
    if (!m) continue;
    for (const a of m.attachments || []) if (!inUse.has(a.id)) await S.db.blobs.delete(a.id);
    S.msgs.delete(id);
    await S.db.messages.delete(id);
  }
  emit('msgs');
}

export function contacts() {
  const map = new Map();
  for (const m of S.msgs.values()) {
    if (m.dir === 'in' && m.from?.address && m.loc !== 'spam') map.set(m.from.address, m.from.name || map.get(m.from.address) || '');
    if (m.dir === 'out' && !m.draft) for (const a of [...(m.to || []), ...(m.cc || []), ...(m.bcc || [])]) if (!map.has(a)) map.set(a, '');
  }
  map.delete(S.account?.address);
  return [...map.entries()].map(([address, name]) => ({ address, name }));
}

export function isKnownSender(address) {
  for (const m of S.msgs.values()) {
    if (m.dir === 'out' && !m.draft && [...(m.to || []), ...(m.cc || []), ...(m.bcc || [])].includes(address)) return true;
    if (m.dir === 'in' && m.from?.address === address && m.loc !== 'spam') return true;
  }
  return false;
}

export function thread(m) {
  if (!m.threadId) return [m];
  const inBin = m.loc === 'bin';
  return [...S.msgs.values()]
    .filter(x => x.threadId === m.threadId && !x.draft && (inBin ? true : x.loc !== 'bin') && (m.loc === 'spam' || x.loc !== 'spam' || x.id === m.id))
    .sort((a, b) => a.date - b.date);
}

export function displayName(address) {
  if (address === S.account?.address) return 'me';
  for (const m of S.msgs.values()) if (m.dir === 'in' && m.from?.address === address && m.from.name) return m.from.name;
  return address;
}
