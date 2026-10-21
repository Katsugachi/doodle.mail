// Message actions shared by the list and the reader.
import { h, icon, download, safeFilename, clear, fmtFullDate } from '../util.js';
import { S, patchMsgs, deleteForever, saveSettings, emit } from '../state.js';
import { buildEml, plainText } from '../mail.js';
import { toast, openMenu, promptDialog, confirmDialog } from './common.js';

const n = (ids) => (ids.length === 1 ? 'Letter' : `${ids.length} letters`);

export const toggleStar = (ids, v) => patchMsgs(ids, m => ({ starred: v ?? !m.starred }));
export const toggleImportant = (ids, v) => patchMsgs(ids, m => ({ important: v ?? !m.important }));
export const setRead = (ids, read) => patchMsgs(ids, { read });

export async function toBin(ids) {
  const before = ids.map(id => [id, S.msgs.get(id)?.loc]);
  await patchMsgs(ids, m => (m.loc === 'bin' ? null : { prevLoc: m.loc, loc: 'bin', binAt: Date.now() }));
  toast(`${n(ids)} moved to Bin`, { action: 'Undo', onAction: () => Promise.all(before.map(([id, loc]) => patchMsgs([id], { loc, binAt: null }))) });
}
export async function restore(ids) {
  await patchMsgs(ids, m => ({ loc: m.prevLoc && m.prevLoc !== 'bin' ? m.prevLoc : (m.dir === 'in' ? 'inbox' : 'sent'), binAt: null }));
  toast(`${n(ids)} restored`);
}
export async function archive(ids) {
  await patchMsgs(ids, m => (m.dir === 'in' ? { loc: 'archive', snoozeUntil: null } : null));
  toast(`${n(ids)} archived`, { action: 'Undo', onAction: () => patchMsgs(ids, m => (m.dir === 'in' ? { loc: 'inbox' } : null)) });
}
export async function moveToInbox(ids) { await patchMsgs(ids, m => (m.dir === 'in' ? { loc: 'inbox', spamReason: null } : { loc: 'sent' })); toast(`${n(ids)} moved to Inbox`); }
export async function markSpam(ids) {
  await patchMsgs(ids, m => ({ prevLoc: m.loc, loc: 'spam', spamReason: m.spamReason || 'reported' }));
  toast(`${n(ids)} marked as spam`, { action: 'Undo', onAction: () => moveToInbox(ids) });
}
export async function forever(ids) {
  if (!(await confirmDialog('Delete forever?', `${n(ids)} will be erased from this device. This can't be undone.`, 'Delete forever', { danger: true, iconName: 'trash' }))) return false;
  await deleteForever(ids);
  toast(`${n(ids)} deleted forever`);
  return true;
}
export async function emptyFolder(folder) {
  const ids = [...S.msgs.values()].filter(m => m.loc === folder).map(m => m.id);
  if (!ids.length) return;
  if (await forever(ids)) emit('msgs');
}

export function snoozeMenu(anchor, ids) {
  const at = (d) => d.getTime();
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 3600e3);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  const weekend = new Date(now); weekend.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7)); weekend.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now); nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); nextWeek.setHours(8, 0, 0, 0);
  const fmt = (d) => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const go = async (t) => { await patchMsgs(ids, { snoozeUntil: t }); toast(`Snoozed until ${new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`, { action: 'Undo', onAction: () => patchMsgs(ids, { snoozeUntil: null }) }); emit('snoozed'); };
  const picker = h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'Pick date and time' });
  const pad = (x) => String(x).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  picker.min = local(new Date(now.getTime() + 60000));
  picker.value = local(tomorrow);
  const custom = h('div', { style: { display: 'grid', gap: '6px', padding: '4px 8px 6px' } }, picker,
    h('button', { class: 'btn sm primary', onclick: () => { const t = new Date(picker.value).getTime(); if (t > Date.now()) { go(t); document.querySelector('.menu')?.remove(); } } }, 'Snooze until then'));
  const isSn = ids.some(id => S.msgs.get(id)?.snoozeUntil > Date.now());
  openMenu(anchor, [
    { head: 'Snooze until…' },
    { label: 'Later today', right: fmt(later), icon: 'clock', onClick: () => go(at(later)) },
    { label: 'Tomorrow', right: fmt(tomorrow), icon: 'sun', onClick: () => go(at(tomorrow)) },
    { label: 'This weekend', right: fmt(weekend), icon: 'smile', onClick: () => go(at(weekend)) },
    { label: 'Next week', right: fmt(nextWeek), icon: 'mail', onClick: () => go(at(nextWeek)) },
    'sep', { head: 'Pick date & time' }, custom,
    isSn ? 'sep' : null,
    isSn ? { label: 'Unsnooze now', icon: 'x', onClick: () => patchMsgs(ids, { snoozeUntil: null, sortDate: Date.now() }) } : null,
  ], { width: 300 });
}

export function labelMenu(anchor, ids) {
  const msgs = ids.map(id => S.msgs.get(id)).filter(Boolean);
  const items = S.settings.labels.map(l => {
    const all = msgs.every(m => (m.labels || []).includes(l.id));
    return {
      label: l.name, icon: all ? 'check' : 'label', keepOpen: true,
      onClick: async (e) => {
        const on = !msgs.every(m => (m.labels || []).includes(l.id));
        await patchMsgs(ids, m => ({ labels: on ? [...new Set([...(m.labels || []), l.id])] : (m.labels || []).filter(x => x !== l.id) }));
        const btn = e.currentTarget;
        btn.replaceChild(icon(on ? 'check' : 'label'), btn.firstChild);
      },
    };
  });
  openMenu(anchor, [{ head: 'Label as' }, ...items, 'sep', {
    label: 'New label…', icon: 'plus', onClick: async () => {
      const name = await promptDialog('New label', 'Label name', '', { iconName: 'label', okLabel: 'Create' });
      if (!name) return;
      const l = createLabel(name);
      if (l) await patchMsgs(ids, m => ({ labels: [...new Set([...(m.labels || []), l.id])] }));
    },
  }]);
}

export function createLabel(name) {
  const clean = name.trim().slice(0, 40);
  if (!clean) return null;
  const existing = S.settings.labels.find(l => l.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const l = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), name: clean };
  S.settings.labels.push(l);
  saveSettings();
  emit('settings');
  return l;
}

export async function blockSender(address) {
  if (!address || address === 'team') return;
  if (!(await confirmDialog(`Block ${address}?`, `Future letters from ${address}@doodle.mail go straight to Spam, and existing ones will be moved there.`, 'Block', { danger: true, iconName: 'ban' }))) return;
  if (!S.settings.blocked.includes(address)) S.settings.blocked.push(address);
  saveSettings();
  await patchMsgs([...S.msgs.values()].filter(m => m.dir === 'in' && m.from.address === address && m.loc !== 'bin').map(m => m.id), m => ({ prevLoc: m.loc, loc: 'spam', spamReason: 'blocked' }));
  toast(`${address} blocked`);
}
export function unblock(address) {
  S.settings.blocked = S.settings.blocked.filter(a => a !== address);
  saveSettings(); emit('settings');
}

export async function copyMsg(m) {
  try { await navigator.clipboard.writeText(plainText(m)); toast('Copied to clipboard'); }
  catch { toast('Clipboard is not available here'); }
}

export async function downloadEml(m) {
  download(await buildEml(m), safeFilename((m.subject || 'letter').slice(0, 60)) + '.eml');
}

export async function downloadAtt(a) {
  const b = await S.db.blobs.get(a.id);
  if (!b) return toast('That attachment is missing.');
  download(b, a.name);
}

export async function downloadAllAtts(m) {
  for (const a of m.attachments || []) { await downloadAtt(a); await new Promise(r => setTimeout(r, 250)); }
}

export function printMsgs(msgs) {
  const root = clear(document.getElementById('print-root'));
  for (const m of msgs) {
    root.appendChild(h('div', { class: 'pmsg' },
      h('h1', null, m.subject),
      h('div', { class: 'meta' },
        h('div', null, `From: ${m.from.name || ''} <${m.from.address}@doodle.mail>`),
        h('div', null, `To: ${m.to.map(a => a + '@doodle.mail').join(', ')}`),
        m.cc.length ? h('div', null, `Cc: ${m.cc.map(a => a + '@doodle.mail').join(', ')}`) : null,
        h('div', null, `Date: ${fmtFullDate(m.date)}`)),
      h('div', { class: 'body' }, m.text),
      m.attachments.length ? h('div', { class: 'atts' }, 'Attachments: ' + m.attachments.map(a => a.name).join(', ')) : null));
  }
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 1000); }, 50);
}
