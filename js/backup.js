// Export / import a full local backup (account, identity, settings, messages, attachments).
import { S, saveSettings, upsertAccount, loadSettings } from './state.js';
import { openDB } from './db.js';

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
export { bufToB64, b64ToBuf };

export async function exportBackup() {
  const msgs = await S.db.messages.all();
  const blobIds = new Set();
  msgs.forEach(m => (m.attachments || []).forEach(a => blobIds.add(a.id)));
  const blobs = [];
  for (const id of blobIds) {
    const b = await S.db.blobs.get(id);
    if (b) blobs.push({ id, type: b.type, b64: bufToB64(await b.arrayBuffer()) });
  }
  const keys = [];
  for (const m of msgs) if (m.dir === 'in' && m.from?.address) {
    const k = await S.db.kv.get('key:' + m.from.address);
    if (k && !keys.find(x => x.address === m.from.address)) keys.push({ address: m.from.address, jwk: k });
  }
  return new Blob([JSON.stringify({
    format: 'doodlemail-backup', v: 1, exportedAt: Date.now(),
    account: S.account, settings: S.settings, identity: S.identity, messages: msgs, blobs, keys,
  })], { type: 'application/json' });
}

export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data?.format !== 'doodlemail-backup' || !data.account?.address || !data.identity?.privateJwk) throw new Error('That file is not a doodle.mail backup.');
  const address = String(data.account.address);
  const db = await openDB(address);
  await db.kv.set('identity', data.identity);
  for (const b of data.blobs || []) await db.blobs.put(b.id, new Blob([b64ToBuf(b.b64)], { type: b.type || 'application/octet-stream' }));
  if (Array.isArray(data.messages)) await db.messages.bulkPut(data.messages);
  for (const k of data.keys || []) await db.kv.set('key:' + k.address, k.jwk);
  db.close();
  upsertAccount({ address, name: data.account.name || address, createdAt: data.account.createdAt || Date.now() });
  const s = { ...loadSettings(address, data.account.name), ...(data.settings || {}) };
  localStorage.setItem(`doodlemail:settings:${address}`, JSON.stringify(s));
  void saveSettings;
  return address;
}
