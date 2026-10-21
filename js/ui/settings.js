// Settings: appearance, general, signatures, labels, spam & blocking, network, account.
import { h, icon, clear, fmtSize, uuid, download, debounce } from '../util.js';
import { S, saveSettings, applyTheme, emit, patchMsgs } from '../state.js';
import { normalizeAddress } from '../net.js';
import { exportBackup } from '../backup.js';
import { toast, confirmDialog, promptDialog, modal } from './common.js';
import { termsBody } from './terms.js';
import { createLabel, unblock } from './actions.js';

export const TABS = [
  ['general', 'General', 'gear'],
  ['appearance', 'Appearance', 'palette'],
  ['signatures', 'Signatures', 'signature'],
  ['labels', 'Labels', 'label'],
  ['spam', 'Spam & blocking', 'shield'],
  ['network', 'Network', 'wifi'],
  ['account', 'Account & data', 'user'],
  ['about', 'About & terms', 'info'],
];

const set = (k, v) => { S.settings[k] = v; saveSettings(); emit('settings'); };
const section = (...kids) => h('div', { class: 'set-section' }, kids);
const row = (t, hint, control) => h('div', { class: 'set-row' }, h('div', { class: 'txt' }, h('span', { class: 't' }, t), hint ? h('span', { class: 'hint' }, hint) : null), control);
const toggle = (key, onChange) => {
  const i = h('input', { type: 'checkbox', checked: !!S.settings[key], role: 'switch' });
  i.addEventListener('change', async () => { if (onChange && (await onChange(i.checked)) === false) { i.checked = !i.checked; return; } set(key, i.checked); });
  return h('label', { class: 'toggle' }, i, h('span'));
};

export function renderSettings(pane, tab, hooks) {
  if (!TABS.find(t => t[0] === tab)) tab = 'general';
  clear(pane);
  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' }, h('h2', null, 'Settings'),
    TABS.map(([id, name, ic]) => h('a', { class: 'nav-item' + (id === tab ? ' active' : ''), href: `#/settings/${id}`, 'aria-current': id === tab ? 'page' : null }, icon(ic), name)));
  const body = h('div', { class: 'settings-body' });
  pane.append(nav, body);
  ({ general, appearance, signatures, labels, spam, network, account, about })[tab](body, hooks);
}

function head(body, title, hint) { body.append(h('h3', null, title), h('div', { class: 'hint' }, hint)); }

function general(body) {
  head(body, 'General', 'How your notebook behaves day to day.');
  const name = h('input', { class: 'input', value: S.account.name, maxlength: 40, style: { maxWidth: '320px' } });
  name.addEventListener('change', () => {
    const v = name.value.trim();
    if (!v) { name.value = S.account.name; return; }
    S.account.name = v;
    const list = JSON.parse(localStorage.getItem('doodlemail:accounts') || '[]').map(a => (a.address === S.account.address ? { ...a, name: v } : a));
    localStorage.setItem('doodlemail:accounts', JSON.stringify(list));
    emit('account'); toast('Name updated');
  });
  const undo = h('select', { class: 'select', style: { width: '160px' } }, [0, 5, 10, 20, 30].map(s => h('option', { value: s, selected: Number(S.settings.undoSeconds) === s }, s ? `${s} seconds` : 'Off')));
  undo.addEventListener('change', () => set('undoSeconds', Number(undo.value)));
  body.append(
    section(row('Display name', 'Shown to people you write to.', name)),
    section(
      row('Undo send', 'A short grace period to take a letter back.', undo),
      row('Mark as read when opened', null, toggle('autoMarkRead')),
      row('Desktop notifications', 'Get a ping when a letter arrives while this tab is in the background.', toggle('notifications', async (on) => {
        if (!on) return true;
        if (!('Notification' in window)) { toast('Notifications are not supported here'); return false; }
        const p = await Notification.requestPermission();
        if (p !== 'granted') { toast('Notifications were blocked by the browser'); return false; }
        return true;
      })),
      row('Keyboard shortcuts', 'Press ? anywhere to see them.', toggle('shortcuts'))));
}

function appearance(body) {
  head(body, 'Appearance', 'Pick your paper and how tightly letters are packed.');
  const theme = h('div', { class: 'theme-cards', role: 'radiogroup', 'aria-label': 'Theme' },
    [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Match system', 'palette']].map(([id, n, ic]) =>
      h('button', { class: 'theme-card' + (S.settings.theme === id ? ' on' : ''), role: 'radio', 'aria-checked': String(S.settings.theme === id), onclick: () => { set('theme', id); applyTheme(); appearanceRerender(body); } },
        h('div', { class: `theme-swatch ${id}` }, h('i')), h('span', null, icon(ic), ' ', n))));
  const dens = h('div', { class: 'density-demo', role: 'radiogroup', 'aria-label': 'Density' },
    [['comfortable', 'Comfortable', 12], ['default', 'Default', 8], ['compact', 'Compact', 4]].map(([id, n, gap]) =>
      h('button', { class: 'density-card' + (S.settings.density === id ? ' on' : ''), role: 'radio', 'aria-checked': String(S.settings.density === id), onclick: () => { set('density', id); applyTheme(); appearanceRerender(body); } },
        h('span', null, n), h('span', { class: 'bars', style: { gap: gap + 'px' } }, h('i'), h('i'), h('i'), h('i')))));
  body.append(section(h('div', { class: 't' }, 'Theme'), theme), section(h('div', { class: 't' }, 'Inbox density'), dens, h('div', { class: 'hint' }, 'Compact hides previews so you can see more letters at once.')));
}
function appearanceRerender(body) { clear(body); appearance(body); }

function signatures(body) {
  head(body, 'Signatures', 'Added to the end of letters when you send them. You can switch per letter from the compose window.');
  const list = h('div', { class: 'sig-list' });
  const pick = (key, label) => {
    const sel = h('select', { class: 'select', style: { width: '220px' } },
      h('option', { value: '' }, 'No signature'),
      S.settings.signatures.map(s => h('option', { value: s.id, selected: S.settings[key] === s.id }, s.name)));
    sel.addEventListener('change', () => set(key, sel.value || null));
    return row(label, null, sel);
  };
  const save = debounce(() => { saveSettings(); emit('settings'); }, 400);
  S.settings.signatures.forEach((s) => {
    const name = h('input', { class: 'input', value: s.name, maxlength: 40, 'aria-label': 'Signature name' });
    const text = h('textarea', { class: 'textarea', 'aria-label': 'Signature text', maxlength: 2000 });
    text.value = s.text;
    name.addEventListener('input', () => { s.name = name.value || 'Untitled'; save(); });
    text.addEventListener('input', () => { s.text = text.value; save(); });
    list.appendChild(h('div', { class: 'sig-card' },
      h('div', { class: 'row-top' }, icon('signature'), name,
        h('button', { class: 'icon-btn', title: 'Delete signature', 'aria-label': 'Delete signature', onclick: async () => {
          if (!(await confirmDialog('Delete signature?', `"${s.name}" will be removed.`, 'Delete', { danger: true }))) return;
          S.settings.signatures = S.settings.signatures.filter(x => x.id !== s.id);
          if (S.settings.sigNew === s.id) S.settings.sigNew = null;
          if (S.settings.sigReply === s.id) S.settings.sigReply = null;
          saveSettings(); clear(body); signatures(body);
        } }, icon('trash'))), text));
  });
  body.append(
    section(pick('sigNew', 'For new letters'), pick('sigReply', 'For replies & forwards')),
    section(list, h('div', null, h('button', { class: 'btn', onclick: () => {
      S.settings.signatures.push({ id: uuid(), name: `Signature ${S.settings.signatures.length + 1}`, text: `- ${S.account.name}` });
      saveSettings(); clear(body); signatures(body);
    } }, icon('plus'), 'Add signature'))));
}

function labels(body) {
  head(body, 'Labels', 'Little folder tabs to sort letters. A letter can have many.');
  const list = h('div', { class: 'label-list' });
  const counts = {};
  for (const m of S.msgs.values()) for (const l of m.labels || []) counts[l] = (counts[l] || 0) + 1;
  S.settings.labels.forEach(l => list.appendChild(h('div', { class: 'list-line' }, icon('label'), h('span', { class: 'grow' }, l.name), h('span', { class: 'muted' }, String(counts[l.id] || 0)),
    h('button', { class: 'icon-btn sm', title: 'Rename', 'aria-label': `Rename ${l.name}`, onclick: async () => {
      const n = await promptDialog('Rename label', 'Label name', l.name, { iconName: 'label' });
      if (!n) return; l.name = n.slice(0, 40); saveSettings(); emit('settings'); clear(body); labels(body);
    } }, icon('pencil')),
    h('button', { class: 'icon-btn sm', title: 'Delete', 'aria-label': `Delete ${l.name}`, onclick: async () => {
      if (!(await confirmDialog(`Delete "${l.name}"?`, 'Letters keep their place; they just lose this label.', 'Delete label', { danger: true }))) return;
      S.settings.labels = S.settings.labels.filter(x => x.id !== l.id); saveSettings();
      await patchMsgs([...S.msgs.values()].filter(m => (m.labels || []).includes(l.id)).map(m => m.id), m => ({ labels: m.labels.filter(x => x !== l.id) }));
      emit('settings'); clear(body); labels(body);
    } }, icon('trash')))));
  if (!S.settings.labels.length) list.appendChild(h('div', { class: 'hint' }, 'No labels yet.'));
  const input = h('input', { class: 'input', placeholder: 'New label name', maxlength: 40 });
  const add = () => { if (createLabel(input.value)) { clear(body); labels(body); } };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  body.append(section(list), section(h('div', { class: 'inline-form' }, input, h('button', { class: 'btn', onclick: add }, icon('plus'), 'Add label'))));
}

async function spam(body) {
  head(body, 'Spam & blocking', 'Keep unwanted letters out of your inbox.');
  const list = h('div', { class: 'block-list' });
  S.settings.blocked.forEach(a => list.appendChild(h('div', { class: 'list-line' }, icon('ban'), h('span', { class: 'grow' }, `${a}@doodle.mail`),
    h('button', { class: 'btn sm', onclick: () => { unblock(a); clear(body); spam(body); } }, 'Unblock'))));
  if (!S.settings.blocked.length) list.appendChild(h('div', { class: 'hint' }, 'Nobody is blocked.'));
  const input = h('input', { class: 'input', placeholder: 'address to block', maxlength: 40 });
  const add = () => {
    const a = normalizeAddress(input.value);
    if (!a) return toast('That is not a valid address');
    if (!S.settings.blocked.includes(a)) S.settings.blocked.push(a);
    saveSettings(); clear(body); spam(body);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const keys = h('div', { class: 'block-list' }, h('div', { class: 'hint' }, 'Loading…'));
  body.append(
    section(row('Send strangers to Spam', "Letters from addresses you've never written to or heard from land in Spam.", toggle('strangersToSpam')),
      h('div', { class: 'hint' }, 'Letters with a bad signature, or whose sender key changed, always go to Spam.')),
    section(h('div', { class: 't' }, 'Blocked addresses'), list, h('div', { class: 'inline-form' }, input, h('button', { class: 'btn', onclick: add }, icon('ban'), 'Block'))),
    section(h('div', { class: 't' }, 'Trusted keys'), h('div', { class: 'hint' }, "The first key seen for each address is pinned. Forget a key only if a friend tells you they've moved to a new browser."), keys));
  const senders = [...new Set([...S.msgs.values()].filter(m => m.dir === 'in' && m.from.address !== 'team' && m.from.address !== S.account.address).map(m => m.from.address))];
  clear(keys);
  let any = false;
  for (const a of senders) {
    const k = await S.db.kv.get('key:' + a);
    if (!k) continue;
    any = true;
    const fpm = [...S.msgs.values()].find(m => m.from.address === a && m.fingerprint && m.verified !== 'mismatch');
    keys.appendChild(h('div', { class: 'list-line' }, icon('key'), h('span', { class: 'grow' }, `${a}@doodle.mail`), fpm ? h('span', { class: 'fingerprint' }, fpm.fingerprint) : null,
      h('button', { class: 'btn sm', onclick: async () => {
        if (!(await confirmDialog(`Forget ${a}'s key?`, 'The next letter from this address will be trusted as new.', 'Forget key', { danger: true }))) return;
        await S.db.kv.delete('key:' + a); clear(body); spam(body);
      } }, 'Forget')));
  }
  if (!any) keys.appendChild(h('div', { class: 'hint' }, 'No keys pinned yet.'));
}

function network(body, hooks) {
  head(body, 'Network', 'How your browser finds other browsers. The defaults work for most people.');
  const n = S.settings.network;
  const host = h('input', { class: 'input', value: n.host, placeholder: '0.peerjs.com (default)' });
  const port = h('input', { class: 'input', value: n.port, placeholder: '443', inputmode: 'numeric' });
  const path = h('input', { class: 'input', value: n.path, placeholder: '/' });
  const secure = h('input', { type: 'checkbox', checked: n.secure !== false });
  const ice = h('textarea', { class: 'textarea', placeholder: '[{"urls":"stun:stun.l.google.com:19302"}, {"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]', spellcheck: 'false' });
  ice.value = n.iceServers || '';
  const pending = [...S.msgs.values()].filter(m => m.dir === 'out' && !m.draft && Object.values(m.delivery || {}).some(d => d.state === 'queued' || d.state === 'sending'));
  body.append(
    section(row('Status', `Your peer id: doodlemail-v1-${S.account.address}`, h('span', { class: `status-pill ${S.status}` }, h('i'), S.status)),
      row('Outbox', pending.length ? `${pending.length} letter${pending.length > 1 ? 's' : ''} waiting for recipients to come online.` : 'Nothing waiting.', h('button', { class: 'btn sm', disabled: !pending.length, onclick: () => { S.transport?.retryNow(); toast('Retrying deliveries…'); } }, icon('refresh'), 'Retry now'))),
    section(h('div', { class: 't' }, 'Signalling server (PeerJS)'), h('div', { class: 'hint' }, 'Leave blank to use the free PeerJS cloud. Self-host a PeerJS server for more privacy and reliability. Everyone you write to must use the same server.'),
      h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', null, 'Host'), host), h('div', { class: 'field' }, h('label', null, 'Port'), port), h('div', { class: 'field' }, h('label', null, 'Path'), path),
        h('label', { class: 'check', style: { alignSelf: 'end', paddingBottom: '10px' } }, secure, h('span', null, 'Use TLS (wss/https)')))),
    section(h('div', { class: 't' }, 'ICE servers (STUN/TURN)'), h('div', { class: 'hint' }, 'JSON array. Add a TURN server if letters never arrive between strict networks (e.g. corporate or mobile).'), ice),
    h('div', { style: { display: 'flex', gap: '12px', paddingTop: '16px' } },
      h('button', { class: 'btn primary', onclick: () => {
        if (ice.value.trim()) { try { const v = JSON.parse(ice.value); if (!Array.isArray(v)) throw 0; } catch { return toast('ICE servers must be a JSON array'); } }
        S.settings.network = { host: host.value.trim(), port: port.value.trim(), path: path.value.trim(), secure: secure.checked, iceServers: ice.value.trim() };
        saveSettings(); hooks.reconnect(); toast('Saved, reconnecting…');
      } }, icon('check'), 'Save & reconnect'),
      h('button', { class: 'btn ghost', onclick: () => { S.settings.network = { host: '', port: '', path: '', secure: true, iceServers: '' }; saveSettings(); hooks.reconnect(); clear(body); network(body, hooks); } }, 'Reset to defaults')));
}

async function account(body, hooks) {
  head(body, 'Account & data', 'Your address and everything stored in this browser.');
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const copy = h('button', { class: 'icon-btn', title: 'Copy address', 'aria-label': 'Copy address', onclick: () => navigator.clipboard?.writeText(`${S.account.address}@doodle.mail`).then(() => toast('Address copied')) }, icon('copy'));
  body.append(
    section(h('div', { class: 'address-big' }, h('div', { class: 'avatar lg' }, S.account.name[0].toUpperCase()), `${S.account.address}@doodle.mail`, copy),
      row('Key fingerprint', 'Friends can compare this with what they see on your letters.', h('span', { class: 'fingerprint' }, S.fingerprint)),
      row('Created', null, h('span', null, new Date(S.account.createdAt || Date.now()).toLocaleDateString()))),
    section(row('Storage used', est ? `${fmtSize(est.usage)} of about ${fmtSize(est.quota)} available to this site.` : 'Unknown', h('span', null, `${S.msgs.size} letters`)),
      row('Keep data safe', persisted ? 'The browser has agreed not to clear this data automatically.' : 'Ask the browser not to evict your mail when space is low.',
        h('button', { class: 'btn sm', disabled: persisted, onclick: async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? 'Storage is now persistent' : 'The browser declined (try installing or bookmarking the site)'); clear(body); account(body, hooks); } }, icon('shield'), persisted ? 'Persistent' : 'Make persistent'))),
    section(row('Export backup', 'Downloads a file with your mail, settings and private key. Keep it somewhere safe; anyone with it can send as you.',
      h('button', { class: 'btn sm', onclick: async () => { const b = await exportBackup(); download(b, `doodlemail-${S.account.address}-backup.json`); } }, icon('download'), 'Export')),
      row('Import a backup', 'Use the Restore tab on the sign-in screen to open a backup in a new browser.', h('span'))),
    section(row('Sign out', 'Close this notebook. Your mail stays saved in this browser.', h('button', { class: 'btn sm', onclick: hooks.signOut }, icon('logout'), 'Sign out')),
      row('Delete account', 'Erase this address, its key and all its mail from this browser.', h('button', { class: 'btn sm danger', onclick: async () => {
        const typed = await promptDialog('Delete account', `Type "${S.account.address}" to erase everything for this address.`, '', { okLabel: 'Delete everything', iconName: 'trash' });
        if (typed !== S.account.address) { if (typed) toast("That didn't match"); return; }
        hooks.deleteAccount();
      } }, icon('trash'), 'Delete…'))));
}

function about(body) {
  head(body, 'About & terms', 'doodle.mail, a peer-to-peer notebook mailbox.');
  body.append(
    section(h('div', { class: 'terms-text' },
      h('h3', null, 'How it works'),
      h('p', null, 'Each address maps to a WebRTC peer id. When you send a letter, your browser connects straight to your friend\'s browser (via a public signalling server that only introduces you) and hands it over. It is signed with your private key, which never leaves this device.'),
      h('p', null, 'If they are offline, the letter waits in your Outbox and retries automatically, and as soon as they connect to you for any reason the queue flushes.'),
      h('h3', null, 'Safety'),
      h('p', null, 'Letters are shown as plain text. HTML attachments render inside a sandboxed frame with its own strict Content-Security-Policy: scripts can run there, but it has no network access, no cookies or storage, and cannot reach this page.'),
      h('p', null, 'Keyboard: press ', h('span', { class: 'kbd' }, '?'), ' to see shortcuts.'))),
    section(h('div', { class: 't' }, 'Terms of Service'), termsBody()),
    section(h('div', { class: 'hint' }, 'Font: Patrick Hand (SIL OFL). Networking: PeerJS (MIT).'), h('div', null, h('button', { class: 'btn sm', onclick: () => modal({ title: 'Terms of Service', iconName: 'file', wide: true, body: termsBody(), actions: [{ label: 'Close', primary: true }] }) }, icon('file'), 'Open terms'))));
}
