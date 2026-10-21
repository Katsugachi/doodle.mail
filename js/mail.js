// Mail operations: drafts, sending, receiving, delivery tracking, exports.
import { S, saveMsg, emit, isKnownSender } from './state.js';
import { uuid, fileKind, safeFilename } from './util.js';
import { bufToB64 } from './backup.js';

export const MAX_TOTAL = 25 * 1024 * 1024;
const RASTER = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;

export function me() { return { address: S.account.address, name: S.account.name }; }

export function sigText(sigId) {
  return S.settings.signatures.find(s => s.id === sigId)?.text || '';
}

export function newDraft(init = {}) {
  const now = Date.now();
  return {
    id: uuid(), mid: null, threadId: init.threadId || uuid(), inReplyTo: init.inReplyTo || null,
    from: me(), to: init.to || [], cc: init.cc || [], bcc: init.bcc || [],
    subject: init.subject || '', text: init.text || '', attachments: init.attachments || [],
    sigId: init.sigId !== undefined ? init.sigId : (init.inReplyTo ? S.settings.sigReply : S.settings.sigNew),
    date: now, sortDate: now, dir: 'out', draft: true, read: true, starred: false, important: false,
    labels: [], loc: 'sent', snoozeUntil: null, delivery: {},
  };
}

export async function storeFile(file) {
  const id = uuid();
  const type = RASTER.test(file.type) ? file.type : (file.type || 'application/octet-stream');
  await S.db.blobs.put(id, new Blob([file], { type }));
  return { id, name: safeFilename(file.name || 'file'), type, size: file.size };
}

export async function cloneAtts(atts = []) {
  const out = [];
  for (const a of atts) {
    const b = await S.db.blobs.get(a.id);
    if (!b) continue;
    const id = uuid();
    await S.db.blobs.put(id, b);
    out.push({ ...a, id });
  }
  return out;
}

function envelopeFor(m, recipient, bccSet) {
  return {
    v: 1, type: 'mail', mid: m.mid, threadId: m.threadId, inReplyTo: m.inReplyTo || null,
    from: me(), to: m.to, cc: m.cc,
    ...(bccSet.has(recipient) ? { bcc: [recipient] } : {}),
    subject: m.subject, text: m.text, date: new Date(m.date).toISOString(),
    attachments: m.attachments.map(({ id, name, type, size }) => ({ id, name, type, size })),
  };
}

export async function sendDraft(m) {
  const sig = sigText(m.sigId);
  if (sig && !m.text.includes(sig)) m.text = m.text.replace(/\s+$/, '') + '\n\n' + sig;
  m.sigId = null;
  m.draft = false;
  m.mid = m.mid || uuid();
  m.date = m.sortDate = Date.now();
  m.loc = 'sent';
  m.from = me();
  m.subject = m.subject.trim() || '(no subject)';
  const visible = [...new Set([...m.to, ...m.cc])];
  const bccSet = new Set(m.bcc.filter(a => !visible.includes(a)));
  const all = [...visible, ...bccSet];
  m.delivery = Object.fromEntries(all.map(r => [r, { state: 'queued', at: Date.now() }]));
  await saveMsg(m);
  for (const r of all) {
    const envelope = envelopeFor(m, r, bccSet);
    if (r === S.account.address) {
      const atts = [];
      for (const a of envelope.attachments) {
        const b = await S.db.blobs.get(a.id);
        atts.push({ ...a, data: b ? await b.arrayBuffer() : new ArrayBuffer(0) });
      }
      await onIncoming({ ...envelope, attachments: atts }, { verified: 'self' });
      onDelivery({ mid: m.mid, recipient: r }, 'delivered', {});
      continue;
    }
    S.transport?.enqueue({ id: `${m.mid}:${r}`, mid: m.mid, recipient: r, envelope, createdAt: Date.now(), attempts: 0, nextAttempt: Date.now(), lastError: null });
  }
  return m;
}

export function onDelivery(item, state, info = {}) {
  const m = [...S.msgs.values()].find(x => x.mid === item.mid && x.dir === 'out');
  if (!m) return;
  const prev = m.delivery?.[item.recipient]?.state;
  m.delivery = { ...(m.delivery || {}), [item.recipient]: { state, at: Date.now(), error: info.error ? String(info.error) : null, nextAttempt: info.nextAttempt || null } };
  saveMsg(m);
  if (state === 'delivered' && prev !== 'delivered') emit('delivered:' + item.recipient);
}

function safeIncomingType(name, type) {
  if (RASTER.test(type) && fileKind(name, type) === 'image') return type;
  return 'application/octet-stream';
}

export async function onIncoming(env, meta) {
  const existing = [...S.msgs.values()].find(x => x.mid === env.mid && x.dir === 'in');
  if (existing) return;
  const atts = [];
  for (const a of env.attachments || []) {
    const id = uuid();
    const type = safeIncomingType(String(a.name || ''), String(a.type || ''));
    await S.db.blobs.put(id, new Blob([a.data], { type }));
    atts.push({ id, name: safeFilename(String(a.name || 'file')), type, size: a.data?.byteLength ?? a.size ?? 0 });
  }
  const from = { address: String(env.from?.address || ''), name: String(env.from?.name || '').slice(0, 80) };
  const blocked = S.settings.blocked.includes(from.address);
  const suspicious = meta.verified === 'invalid' || meta.verified === 'mismatch';
  const stranger = S.settings.strangersToSpam && meta.verified !== 'self' && !isKnownSender(from.address);
  const now = Date.now();
  const m = {
    id: uuid(), mid: env.mid, threadId: env.threadId || env.mid, inReplyTo: env.inReplyTo || null,
    from, to: env.to || [], cc: env.cc || [], bcc: env.bcc || [],
    subject: String(env.subject || '(no subject)'), text: String(env.text || ''), attachments: atts,
    date: Math.min(Date.parse(env.date) || now, now + 60000), sortDate: now, receivedAt: now, dir: 'in', draft: false,
    read: false, starred: false, important: false, labels: [],
    loc: blocked || suspicious || stranger ? 'spam' : 'inbox', snoozeUntil: null,
    verified: meta.verified, fingerprint: meta.fingerprint || '',
    spamReason: blocked ? 'blocked' : suspicious ? meta.verified : stranger ? 'stranger' : null,
  };
  await saveMsg(m);
  emit('incoming:' + m.id);
}

// ---------- reply / forward ----------
const addPrefix = (p, s) => (new RegExp('^' + p + ':', 'i').test(s.trim()) ? s.trim() : `${p}: ${s.trim()}`);

export function quote(m) {
  const who = m.dir === 'out' ? 'you' : (m.from.name || m.from.address);
  const when = new Date(m.date).toLocaleString();
  return `\n\nOn ${when}, ${who} wrote:\n` + m.text.split('\n').map(l => '> ' + l).join('\n');
}

export function replyInit(m, mode) {
  const myAddr = S.account.address;
  if (mode === 'forward') {
    return {
      subject: addPrefix('Fwd', m.subject), threadId: uuid(), sigId: S.settings.sigNew, forwardOf: m.id,
      text: `\n\n---------- Forwarded message ----------\nFrom: ${m.from.name || ''} <${m.from.address}@doodle.mail>\nDate: ${new Date(m.date).toLocaleString()}\nSubject: ${m.subject}\nTo: ${m.to.join(', ')}\n\n${m.text}`,
    };
  }
  let to, cc = [];
  if (m.dir === 'out') { to = [...m.to]; if (mode === 'replyAll') cc = [...m.cc]; }
  else {
    to = [m.from.address];
    if (mode === 'replyAll') cc = [...m.to, ...m.cc].filter(a => a !== myAddr && a !== m.from.address);
  }
  return { to, cc: [...new Set(cc)], subject: addPrefix('Re', m.subject), threadId: m.threadId, inReplyTo: m.mid, sigId: S.settings.sigReply, text: quote(m) };
}

// ---------- export ----------
const encWord = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(unescape(encodeURIComponent(s)))}?=`;
const wrap = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');
const addrHdr = (a, name) => (name ? `${encWord(name)} <${a}@doodle.mail>` : `<${a}@doodle.mail>`);

export async function buildEml(m) {
  const boundary = 'doodle-' + uuid();
  const lines = [
    `From: ${addrHdr(m.from.address, m.from.name)}`,
    `To: ${m.to.map(a => addrHdr(a)).join(', ')}`,
    m.cc.length ? `Cc: ${m.cc.map(a => addrHdr(a)).join(', ')}` : null,
    m.bcc?.length ? `Bcc: ${m.bcc.map(a => addrHdr(a)).join(', ')}` : null,
    `Subject: ${encWord(m.subject)}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    `Message-ID: <${m.mid || m.id}@doodle.mail>`,
    m.inReplyTo ? `In-Reply-To: <${m.inReplyTo}@doodle.mail>` : null,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '', `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    wrap(btoa(unescape(encodeURIComponent(m.text)))),
  ].filter(l => l !== null);
  for (const a of m.attachments || []) {
    const b = await S.db.blobs.get(a.id);
    if (!b) continue;
    lines.push(`--${boundary}`, `Content-Type: ${a.type || 'application/octet-stream'}; name="${encWord(a.name)}"`,
      `Content-Disposition: attachment; filename="${encWord(a.name)}"`, 'Content-Transfer-Encoding: base64', '',
      wrap(bufToB64(await b.arrayBuffer())));
  }
  lines.push(`--${boundary}--`, '');
  return new Blob([lines.join('\r\n')], { type: 'message/rfc822' });
}

export function plainText(m) {
  return `Subject: ${m.subject}\nFrom: ${m.from.name || ''} <${m.from.address}@doodle.mail>\nTo: ${m.to.map(a => a + '@doodle.mail').join(', ')}${m.cc.length ? `\nCc: ${m.cc.map(a => a + '@doodle.mail').join(', ')}` : ''}\nDate: ${new Date(m.date).toLocaleString()}\n\n${m.text}`;
}
