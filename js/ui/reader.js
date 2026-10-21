// Reading pane: a conversation view of the selected letter.
import { h, icon, clear, fmtFullDate, fmtListDate, fmtSize, initial, fileKind, linkify, snippet } from '../util.js';
import { S, thread, patchMsgs, displayName, isPending, saveMsg } from '../state.js';
import { replyInit, newDraft, sendDraft, sigText } from '../mail.js';
import { renderHtmlPreview } from '../htmlpreview.js';
import { openCompose } from './compose.js';
import { openMenu, toast, emptyState, doodle, modal } from './common.js';
import * as A from './actions.js';

let urls = [];
const revokeAll = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };
const EMOJI = '😀 😂 🥲 😊 😍 🤔 😴 😎 🥳 😢 😮 🙃 👍 👎 👏 🙏 💪 👋 ✌️ 🤝 ❤️ ✨ ⭐ 🔥 🎉 ☕ 🍕 🌈 🌙 ☀️ 🐱 🐾 📎 ✏️ 📬 ✅'.split(' ');

export function renderReaderEmpty(pane) {
  revokeAll();
  clear(pane);
  pane.appendChild(h('div', { class: 'reader-empty' }, h('div', null, doodle('reader'), h('div', { style: { fontSize: '22px', color: 'var(--ink-2)' } }, 'Pick a letter to read'), h('div', null, 'or press ', h('span', { class: 'kbd' }, 'c'), ' to write one'))));
}

export function renderReader(pane, id, { onBack }) {
  const m = S.msgs.get(id);
  revokeAll();
  clear(pane);
  if (!m) { pane.appendChild(emptyState('search', 'This letter is gone', 'It may have been deleted.')); return; }
  const conv = thread(m);
  const last = conv[conv.length - 1] || m;
  const ids = [m.id];
  const inBin = m.loc === 'bin', inSpam = m.loc === 'spam';
  const toolbar = buildToolbar(m, onBack);
  const title = buildTitle(m);
  const scroll = h('div', { class: 'reader-scroll' }, title);
  if (inSpam) {
    const why = { blocked: 'You blocked this sender.', mismatch: "This letter was signed with a different key than earlier letters from this address. Someone may be impersonating them.", invalid: "This letter's signature didn't check out, so it may not be from who it says.", stranger: 'This sender is new to you.', reported: 'You reported this as spam.' }[m.spamReason] || 'This letter is in Spam.';
    scroll.appendChild(h('div', { class: 'banner' }, icon('spam'), h('div', { class: 'grow' }, why), h('button', { class: 'btn sm', onclick: async () => { await A.moveToInbox(ids); onBack(); } }, 'Not spam')));
  }
  if (m.snoozeUntil > Date.now()) scroll.appendChild(h('div', { class: 'banner dashed' }, icon('clock'), h('div', { class: 'grow' }, `Snoozed until ${fmtFullDate(m.snoozeUntil)}`), h('button', { class: 'btn sm', onclick: () => patchMsgs(ids, { snoozeUntil: null, sortDate: Date.now() }) }, 'Unsnooze')));

  conv.forEach((x) => {
    const expanded = x.id === m.id || x.id === last.id || !x.read || conv.length <= 2;
    scroll.appendChild(msgBlock(x, expanded));
  });

  scroll.appendChild(h('div', { class: 'msg-actions' },
    h('button', { class: 'btn', onclick: () => openCompose({ ...replyInit(last, 'reply'), focus: 'body' }) }, icon('reply'), 'Reply'),
    h('button', { class: 'btn', onclick: () => openCompose({ ...replyInit(last, 'replyAll'), focus: 'body' }) }, icon('replyAll'), 'Reply all'),
    h('button', { class: 'btn', onclick: () => openCompose({ ...replyInit(last, 'forward') }) }, icon('forward'), 'Forward')));

  pane.append(toolbar, scroll, quickReply(last));
  if (m.dir === 'in' && !m.read && S.settings.autoMarkRead) setTimeout(() => patchMsgs([m.id], { read: true }), 400);
  conv.filter(x => !x.read && x.id !== m.id && S.settings.autoMarkRead).forEach(x => patchMsgs([x.id], { read: true }));
}

function buildToolbar(m, onBack) {
  const ids = [m.id];
  const inBin = m.loc === 'bin', inSpam = m.loc === 'spam';
  const tb = (ic, label, fn, on) => h('button', { class: 'icon-btn' + (on ? ' on' : ''), title: label, 'aria-label': label, 'data-menu-anchor': '', onclick: fn }, icon(ic));

  const toolbar = h('div', { class: 'reader-toolbar' },
    tb('back', 'Back to list (u)', onBack),
    h('span', { class: 'spacer' }),
    inBin ? tb('restore', 'Restore', async () => { await A.restore(ids); onBack(); }) : null,
    !inBin && !inSpam && m.dir === 'in' && m.loc === 'inbox' ? tb('archive', 'Archive (e)', async () => { await A.archive(ids); onBack(); }) : null,
    !inBin && m.dir === 'in' ? (inSpam ? tb('inbox', 'Not spam', async () => { await A.moveToInbox(ids); onBack(); }) : tb('spam', 'Report spam', async () => { await A.markSpam(ids); onBack(); })) : null,
    inBin ? tb('trash', 'Delete forever', async () => { if (await A.forever(ids)) onBack(); }) : tb('trash', 'Move to Bin (#)', async () => { await A.toBin(ids); onBack(); }),
    tb('mail', 'Mark as unread', async () => { await A.setRead(ids, false); onBack(); }),
    !inBin ? tb('clock', 'Snooze', (e) => A.snoozeMenu(e.currentTarget, ids)) : null,
    tb('label', 'Labels', (e) => A.labelMenu(e.currentTarget, ids)),
    tb(m.important ? 'importantFill' : 'important', m.important ? 'Marked important' : 'Mark important', () => A.toggleImportant(ids), m.important),
    tb(m.starred ? 'starFill' : 'star', m.starred ? 'Starred' : 'Star (s)', () => A.toggleStar(ids), m.starred),
    tb('kebab', 'More', (e) => openMenu(e.currentTarget, msgMenu(m))));

  return toolbar;
}

function buildTitle(m) {
  const ids = [m.id];
  const labels = (m.labels || []).map(l => S.settings.labels.find(x => x.id === l)).filter(Boolean);
  const title = h('div', { class: 'reader-title' },
    h('span', null, m.subject || '(no subject)'),
    h('button', { class: 'icon-btn', 'aria-label': 'Star', onclick: () => A.toggleStar(ids) }, icon(m.starred ? 'starFill' : 'star')),
    labels.length || m.important ? h('span', { class: 'tags' },
      m.important ? h('span', { class: 'mini-tag solid' }, 'important') : null,
      labels.map(l => h('span', { class: 'mini-tag' }, l.name))) : null);

  return title;
}

export function refreshReaderChrome(pane, id, { onBack }) {
  const m = S.msgs.get(id);
  if (!m) return;
  pane.querySelector('.reader-toolbar')?.replaceWith(buildToolbar(m, onBack));
  pane.querySelector('.reader-title')?.replaceWith(buildTitle(m));
}

function msgMenu(m) {
  return [
    { label: 'Reply', icon: 'reply', onClick: () => openCompose({ ...replyInit(m, 'reply'), focus: 'body' }) },
    { label: 'Reply all', icon: 'replyAll', onClick: () => openCompose({ ...replyInit(m, 'replyAll'), focus: 'body' }) },
    { label: 'Forward', icon: 'forward', onClick: () => openCompose(replyInit(m, 'forward')) },
    isPending(m) ? { label: 'Cancel sending & edit', icon: 'x', onClick: () => cancelSending(m) } : null,
    'sep',
    { label: 'Copy text', icon: 'copy', onClick: () => A.copyMsg(m) },
    { label: 'Print', icon: 'print', onClick: () => A.printMsgs([m]) },
    { label: 'Print conversation', icon: 'print', onClick: () => A.printMsgs(thread(m)) },
    { label: 'Download as .eml', icon: 'download', onClick: () => A.downloadEml(m) },
    m.attachments.length ? { label: `Download ${m.attachments.length} attachment${m.attachments.length > 1 ? 's' : ''}`, icon: 'clip', onClick: () => A.downloadAllAtts(m) } : null,
    'sep',
    { label: m.read ? 'Mark as unread' : 'Mark as read', icon: 'mailOpen', onClick: () => A.setRead([m.id], !m.read) },
    m.dir === 'in' && m.loc !== 'spam' ? { label: 'Report spam', icon: 'spam', onClick: () => A.markSpam([m.id]) } : null,
    m.dir === 'in' && m.from.address !== 'team' ? { label: S.settings.blocked.includes(m.from.address) ? `Unblock ${m.from.address}` : `Block ${m.from.address}`, icon: 'ban', onClick: () => (S.settings.blocked.includes(m.from.address) ? A.unblock(m.from.address) : A.blockSender(m.from.address)) } : null,
  ];
}

function verifyLine(x) {
  const fp = x.fingerprint ? h('span', { class: 'fingerprint' }, x.fingerprint) : null;
  switch (x.verified) {
    case 'ok': return [h('span', null, 'Signed · key matches '), fp];
    case 'new': return [h('span', null, 'Signed · first letter, key pinned '), fp];
    case 'mismatch': return [h('b', null, '⚠ Key changed! '), fp];
    case 'invalid': return [h('b', null, '⚠ Signature invalid')];
    case 'system': return [h('span', null, 'Built-in welcome letter')];
    case 'self': return [h('span', null, 'Sent to yourself')];
    default: return [h('span', null, x.dir === 'out' ? 'Signed with your key' : '-')];
  }
}

function msgBlock(x, expanded) {
  const isMe = x.dir === 'out';
  const fromName = isMe ? (x.from.name || 'me') : (x.from.name || x.from.address);
  const toText = () => {
    const all = [...x.to, ...x.cc];
    if (all.length === 1 && all[0] === S.account.address) return 'to me';
    return 'to ' + all.map(a => displayName(a)).slice(0, 3).join(', ') + (all.length > 3 ? ` +${all.length - 3}` : '') + (x.bcc?.length && isMe ? `, bcc ${x.bcc.length}` : '');
  };
  let detailsOpen = false;
  const details = h('dl', { class: 'msg-details', hidden: true },
    h('dt', null, 'from'), h('dd', null, `${x.from.name || ''} <${x.from.address}@doodle.mail>`),
    h('dt', null, 'to'), h('dd', null, x.to.map(a => a + '@doodle.mail').join(', ') || '-'),
    x.cc.length ? [h('dt', null, 'cc'), h('dd', null, x.cc.map(a => a + '@doodle.mail').join(', '))] : null,
    x.bcc?.length ? [h('dt', null, 'bcc'), h('dd', null, x.bcc.map(a => a + '@doodle.mail').join(', '))] : null,
    h('dt', null, 'date'), h('dd', null, fmtFullDate(x.date)),
    h('dt', null, 'security'), h('dd', null, verifyLine(x)));
  const toBtn = h('button', { class: 'msg-to', 'aria-expanded': 'false', onclick: (e) => { e.stopPropagation(); detailsOpen = !detailsOpen; details.hidden = !detailsOpen; toBtn.setAttribute('aria-expanded', String(detailsOpen)); toBtn.replaceChild(icon(detailsOpen ? 'chevronUp' : 'chevronDown'), toBtn.lastChild); } }, toText(), icon('chevronDown'));
  const head = h('div', { class: 'msg-head' },
    h('div', { class: 'avatar lg' }, initial(fromName, x.from.address)),
    h('div', null,
      h('div', { class: 'msg-from' }, fromName, h('span', { class: 'addr' }, `${x.from.address}@doodle.mail`)),
      expanded ? toBtn : h('div', { class: 'msg-collapsed-snip' }, snippet(x.text, 140))),
    h('div', { class: 'msg-meta' }, h('span', { title: fmtFullDate(x.date) }, fmtListDate(x.date)),
      h('button', { class: 'icon-btn', title: 'Reply', 'aria-label': 'Reply', onclick: (e) => { e.stopPropagation(); openCompose({ ...replyInit(x, 'reply'), focus: 'body' }); } }, icon('reply')),
      h('button', { class: 'icon-btn', title: 'More', 'aria-label': 'More actions', 'data-menu-anchor': '', onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, msgMenu(x)); } }, icon('kebab'))));
  const block = h('article', { class: 'msg' + (expanded ? '' : ' collapsed') }, head, details);
  if (!expanded) {
    block.addEventListener('click', () => { block.replaceWith(msgBlock(x, true)); });
    return block;
  }
  if (x.verified === 'mismatch' || x.verified === 'invalid') {
    block.appendChild(h('div', { class: 'banner' }, icon('alert'), h('div', { class: 'grow' }, x.verified === 'mismatch' ? 'The signing key for this address has changed since their earlier letters. Be careful, and check with them another way before trusting it.' : 'This letter could not be verified.')));
  }
  if (isMe && Object.keys(x.delivery || {}).length) block.appendChild(deliveryChips(x));
  block.appendChild(bodyNode(x.text));
  if (x.attachments.length) block.appendChild(attachmentList(x));
  return block;
}

function deliveryChips(x) {
  const lab = { delivered: ['check', 'delivered'], queued: ['clock', 'waiting for them to come online'], sending: ['send', 'sending…'], failed: ['alert', 'failed'] };
  const wrap = h('div', { class: 'delivery' });
  for (const [r, d] of Object.entries(x.delivery)) {
    const [ic, t] = lab[d.state] || ['dot', d.state];
    const tip = d.state === 'queued' && d.nextAttempt ? `next try ${new Date(d.nextAttempt).toLocaleTimeString()}` : (d.at ? new Date(d.at).toLocaleString() : '');
    wrap.appendChild(h('span', { class: 'mini-tag' + (d.state === 'delivered' ? ' solid' : ''), title: tip }, icon(ic), `${r}: ${t}`));
  }
  if (Object.values(x.delivery).some(d => d.state === 'queued')) wrap.appendChild(h('button', { class: 'link-btn', style: { fontSize: '14px' }, onclick: () => { S.transport?.retryNow(); toast('Trying again…'); } }, 'retry now'));
  return wrap;
}

function bodyNode(text) {
  const body = h('div', { class: 'msg-body' });
  const lines = text.split('\n');
  let quote = null;
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? '\n' : '';
    if (/^\s*>/.test(line)) {
      if (!quote) { quote = h('span', { class: 'quote' }); body.appendChild(quote); }
      quote.append(...linkify(line.replace(/^\s*>\s?/, '') + nl));
    } else {
      quote = null;
      body.append(...linkify(line + nl));
    }
  });
  return body;
}

function attachmentList(x) {
  const wrap = h('div', { class: 'attachments' });
  for (const a of x.attachments) {
    const kind = fileKind(a.name, a.type);
    const card = h('div', { class: 'att' },
      icon({ image: 'image', zip: 'zip', html: 'code', text: 'file', pdf: 'file' }[kind] || 'clip'),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'name', title: a.name }, a.name), h('div', { class: 'size' }, `${fmtSize(a.size)}${kind === 'html' ? ' · interactive' : kind === 'zip' ? ' · archive' : ''}`)),
      h('div', { class: 'acts' },
        kind === 'html' ? h('button', { class: 'icon-btn sm', title: 'Render interactive preview', 'aria-label': `Preview ${a.name}`, onclick: () => showHtml(a, wrap, card) }, icon('play')) : null,
        h('button', { class: 'icon-btn sm', title: 'Download', 'aria-label': `Download ${a.name}`, onclick: () => A.downloadAtt(a) }, icon('download'))));
    wrap.appendChild(card);
    if (kind === 'image' && /^image\//.test(a.type)) {
      card.classList.add('has-thumb');
      S.db.blobs.get(a.id).then(b => {
        if (!b || !card.isConnected) return;
        const u = URL.createObjectURL(b);
        urls.push(u);
        const img = h('img', { class: 'att-thumb', src: u, alt: a.name, loading: 'lazy' });
        img.addEventListener('click', () => modal({ title: a.name, iconName: 'image', wide: true, className: 'lightbox', body: h('img', { src: u, alt: a.name, style: { maxWidth: '100%' } }), actions: [{ label: 'Download', icon: 'download', onClick: () => { A.downloadAtt(a); return false; } }, { label: 'Close', primary: true }] }));
        card.appendChild(img);
      });
    }
    if (kind === 'html' && x.verified === 'system') setTimeout(() => card.isConnected && showHtml(a, wrap, card), 0);
  }
  return wrap;
}

async function showHtml(a, wrap, card) {
  if (card._preview) { card._preview.remove(); card._preview = null; return; }
  const b = await S.db.blobs.get(a.id);
  if (!b) return toast('That attachment is missing.');
  if (b.size > 5 * 1024 * 1024) return toast('That HTML file is too big to preview. Download it instead.');
  const html = await b.text();
  const box = h('div', { class: 'html-preview' });
  const head = h('div', { class: 'html-preview-head' }, icon('shield'), h('span', { class: 'grow' }, `${a.name} (sandboxed: scripts on, network & your mail off)`),
    h('button', { class: 'icon-btn sm', title: 'Reload', 'aria-label': 'Reload preview', onclick: () => { inst.destroy(); inst = renderHtmlPreview(box, html, { height: 420 }); } }, icon('refresh')),
    h('button', { class: 'icon-btn sm', title: 'Close preview', 'aria-label': 'Close preview', onclick: () => { box.remove(); card._preview = null; } }, icon('x')));
  box.appendChild(head);
  wrap.after(box);
  let inst = renderHtmlPreview(box, html, { height: 420 });
  card._preview = box;
}

function quickReply(m) {
  const ta = h('textarea', { placeholder: `Quick reply to ${m.dir === 'out' ? displayName(m.to[0] || '') : (m.from.name || m.from.address)}…`, 'aria-label': 'Quick reply', rows: 1, maxlength: 200000 });
  let pop = null;
  const grow = () => { ta.style.height = '42px'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
  ta.addEventListener('input', grow);
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const init = replyInit(m, 'reply');
    const d = newDraft({ ...init, text: text + init.text });
    ta.value = ''; grow();
    const secs = Number(S.settings.undoSeconds) || 0;
    const go = async () => { await sendDraft(d); toast(S.status === 'online' ? 'Reply on its way' : 'Reply queued in Outbox'); };
    if (!secs) return go();
    let undone = false;
    const t = setTimeout(() => !undone && go(), secs * 1000);
    toast('Sending reply…', { action: 'Undo', timeout: secs * 1000, onAction: () => { undone = true; clearTimeout(t); ta.value = text; grow(); ta.focus(); } });
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); send(); } e.stopPropagation(); });
  const wrap = h('div', { class: 'quick-reply' },
    icon('reply'), ta,
    h('button', { class: 'icon-btn', title: 'Emoji', 'aria-label': 'Insert emoji', onclick: () => {
      if (pop) { pop.remove(); pop = null; return; }
      pop = h('div', { class: 'emoji-pop sketch' }, EMOJI.map(em => h('button', { type: 'button', onclick: () => {
        const s = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, s) + em + ta.value.slice(ta.selectionEnd ?? s);
        ta.focus(); ta.selectionStart = ta.selectionEnd = s + em.length; pop.remove(); pop = null; grow();
      } }, em)));
      wrap.appendChild(pop);
    } }, icon('smile')),
    h('button', { class: 'icon-btn', title: 'Send (Enter)', 'aria-label': 'Send quick reply', onclick: send }, icon('send')),
    h('button', { class: 'icon-btn', title: 'Open full editor', 'aria-label': 'Open full reply editor', onclick: () => { const init = replyInit(m, 'reply'); openCompose({ ...init, text: ta.value + init.text, focus: 'body' }); ta.value = ''; } }, icon('expand')));
  void sigText;
  return wrap;
}

async function cancelSending(m) {
  const waiting = Object.entries(m.delivery || {}).filter(([, d]) => d.state === 'queued' || d.state === 'sending').map(([r]) => r);
  for (const r of waiting) await S.transport?.cancel?.(`${m.mid}:${r}`);
  const delivered = Object.entries(m.delivery || {}).filter(([, d]) => d.state === 'delivered').map(([r]) => r);
  if (delivered.length) {
    const rest = { ...m.delivery };
    waiting.forEach(r => { rest[r] = { state: 'failed', error: 'cancelled', at: Date.now() }; });
    await saveMsg({ ...m, delivery: rest });
    toast(`Cancelled for ${waiting.join(', ')} (already delivered to ${delivered.join(', ')})`);
    return;
  }
  await saveMsg({ ...m, draft: true, mid: null, delivery: {}, to: m.to, cc: m.cc, bcc: m.bcc });
  toast('Sending cancelled, moved back to Drafts');
  openCompose({ draftId: m.id });
  location.hash = '#/f/drafts';
}
