// Floating compose windows (new, reply, forward, drafts).
import { h, icon, clear, debounce, fmtSize, fileKind, initial } from '../util.js';
import { S, saveMsg, deleteForever, contacts, emit } from '../state.js';
import { normalizeAddress } from '../net.js';
import { newDraft, storeFile, cloneAtts, sendDraft, sigText, MAX_TOTAL } from '../mail.js';
import { toast, openMenu, modal } from './common.js';

const open = new Map(); // draft id -> controller
let dock = null;

function getDock() {
  if (!dock || !dock.isConnected) { dock = h('div', { class: 'compose-dock' }); document.body.appendChild(dock); }
  return dock;
}

export function closeAllComposers() { for (const c of open.values()) c.destroy(); open.clear(); }

export async function openCompose(init = {}) {
  let rec;
  if (init.draftId) {
    if (open.has(init.draftId)) { open.get(init.draftId).focus(); return; }
    rec = S.msgs.get(init.draftId);
    if (!rec) return;
  } else {
    const atts = init.forwardOf ? await cloneAtts(S.msgs.get(init.forwardOf)?.attachments) : (init.attachments || []);
    rec = newDraft({ ...init, attachments: atts });
  }
  if (open.size >= 3) [...open.values()][0].minimize(true);
  const c = composer(rec, !!init.draftId || !!init.forwardOf);
  open.set(rec.id, c);
  getDock().appendChild(c.el);
  c.focus(init.focus);
}

function composer(rec, persisted) {
  let dirty = false, savedAt = persisted ? Date.now() : 0, destroyed = false;
  const showCc = { cc: rec.cc.length > 0, bcc: rec.bcc.length > 0 };
  const el = h('section', { class: 'compose', 'aria-label': 'Compose message' });
  const title = h('span', { class: 'title' });
  const savedEl = h('span', { class: 'saved', 'aria-live': 'polite' });
  const setTitle = () => { title.textContent = rec.subject.trim() || (rec.inReplyTo ? 'Reply' : 'New message'); };

  const head = h('div', { class: 'compose-head', onclick: (e) => { if (e.target.closest('button')) return; toggleMin(); } },
    icon('pencil'), title,
    h('button', { class: 'icon-btn', title: 'Minimise', 'aria-label': 'Minimise', onclick: () => toggleMin() }, icon('minus')),
    h('button', { class: 'icon-btn', title: 'Expand', 'aria-label': 'Expand', onclick: () => { el.classList.toggle('max'); el.classList.remove('min'); } }, icon('expand')),
    h('button', { class: 'icon-btn', title: 'Save & close', 'aria-label': 'Save and close', onclick: () => close() }, icon('x')));

  const toField = recipField('to', 'To');
  const ccField = recipField('cc', 'Cc');
  const bccField = recipField('bcc', 'Bcc');
  const ccRow = ccField.row, bccRow = bccField.row;
  toField.row.appendChild(h('div', { class: 'toggles' },
    h('button', { type: 'button', onclick: () => { showCc.cc = true; sync(); ccField.input.focus(); } }, 'Cc'),
    h('button', { type: 'button', onclick: () => { showCc.bcc = true; sync(); bccField.input.focus(); } }, 'Bcc')));

  const subject = h('input', { class: 'bare', placeholder: 'Subject', value: rec.subject, maxlength: 500, 'aria-label': 'Subject' });
  subject.addEventListener('input', () => { rec.subject = subject.value; setTitle(); changed(); });
  const body = h('textarea', { class: 'body', placeholder: 'Write something lovely…', 'aria-label': 'Message body', maxlength: 200000 });
  body.value = rec.text;
  body.addEventListener('input', () => { rec.text = body.value; changed(); });
  const sigEl = h('div', { class: 'sig-preview', title: 'Signature (added when sent)' });
  const attsEl = h('div', { class: 'compose-atts' });
  const fileInput = h('input', { type: 'file', multiple: true, class: 'sr-only', tabindex: '-1' });
  const imageInput = h('input', { type: 'file', multiple: true, accept: 'image/*', class: 'sr-only', tabindex: '-1' });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  imageInput.addEventListener('change', () => { addFiles(imageInput.files); imageInput.value = ''; });

  const bodyWrap = h('div', { class: 'compose-body' },
    toField.row, ccRow, bccRow,
    h('div', { class: 'compose-row' }, subject),
    body, sigEl, attsEl, fileInput, imageInput);

  const sendBtn = h('button', { class: 'btn primary', onclick: () => send(), title: 'Send (Ctrl+Enter)' }, icon('send'), 'Send');
  const foot = h('div', { class: 'compose-foot' }, sendBtn,
    h('button', { class: 'icon-btn', title: 'Attach files', 'aria-label': 'Attach files', onclick: () => fileInput.click() }, icon('clip')),
    h('button', { class: 'icon-btn', title: 'Insert images', 'aria-label': 'Insert images', onclick: () => imageInput.click() }, icon('image')),
    h('button', { class: 'icon-btn', title: 'Attach an HTML page (renders as an interactive preview)', 'aria-label': 'Attach HTML', onclick: () => htmlSnippet() }, icon('code')),
    h('button', { class: 'icon-btn', title: 'Signature', 'aria-label': 'Choose signature', 'data-menu-anchor': '', onclick: (e) => sigMenu(e.currentTarget) }, icon('signature')),
    h('span', { class: 'grow' }), savedEl,
    h('button', { class: 'icon-btn', title: 'Discard draft', 'aria-label': 'Discard draft', onclick: () => discard() }, icon('trash')));

  el.append(head, bodyWrap, foot, h('div', { class: 'dropzone' }, icon('upload'), ' Drop files to attach'));

  // drag & drop / paste
  let dragDepth = 0;
  el.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; el.classList.add('dragging'); e.preventDefault(); } });
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  el.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.classList.remove('dragging'); } });
  el.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; el.classList.remove('dragging'); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  body.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  el.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
    if (e.key === 'Escape' && !document.querySelector('.menu, .overlay')) { e.preventDefault(); toggleMin(true); }
    e.stopPropagation();
  });

  function sync() {
    setTitle();
    ccRow.hidden = !showCc.cc; bccRow.hidden = !showCc.bcc;
    toField.render(); ccField.render(); bccField.render();
    const sig = sigText(rec.sigId);
    sigEl.hidden = !sig; sigEl.textContent = sig;
    clear(attsEl);
    rec.attachments.forEach((a, i) => attsEl.appendChild(h('span', { class: 'compose-att', title: `${a.name} · ${fmtSize(a.size)}` },
      icon({ image: 'image', zip: 'zip', html: 'code' }[fileKind(a.name, a.type)] || 'file'),
      h('span', { class: 'nm' }, a.name), h('span', { class: 'muted' }, fmtSize(a.size)),
      h('button', { class: 'icon-btn sm', 'aria-label': `Remove ${a.name}`, onclick: () => { rec.attachments.splice(i, 1); sync(); changed(); } }, icon('x')))));
    const total = rec.attachments.reduce((s, a) => s + a.size, 0);
    if (total) attsEl.appendChild(h('span', { class: 'hint', style: { alignSelf: 'center' } }, `${fmtSize(total)} of 25 MB`));
  }

  function recipField(key, label) {
    const chips = h('div', { class: 'recips' });
    const input = h('input', { class: 'bare', 'aria-label': label, autocomplete: 'off', spellcheck: 'false', placeholder: key === 'to' ? 'friend@doodle.mail' : '' });
    let sugg = null, sIdx = 0, sList = [];
    const row = h('div', { class: 'compose-row' }, h('span', { class: 'lbl' }, label), chips);
    const add = (raw) => {
      const parts = String(raw).split(/[\s,;]+/).filter(Boolean);
      for (const p of parts) {
        const a = normalizeAddress(p) || ('!' + p);
        if (!rec[key].includes(a)) rec[key].push(a);
      }
      if (parts.length) { input.value = ''; render(); changed(); }
    };
    const hideSugg = () => { sugg?.remove(); sugg = null; };
    const showSugg = () => {
      hideSugg();
      const q = input.value.trim().toLowerCase();
      if (!q) return;
      sList = contacts().filter(c => (c.address.includes(q) || (c.name || '').toLowerCase().includes(q)) && !rec[key].includes(c.address)).slice(0, 6);
      if (!sList.length) return;
      sIdx = 0;
      sugg = h('div', { class: 'suggest sketch' }, sList.map((c, i) => h('button', {
        type: 'button', class: i === sIdx ? 'on' : '',
        onpointerdown: (e) => { e.preventDefault(); add(c.address); hideSugg(); input.focus(); },
      }, h('span', { class: 'avatar' }, initial(c.name, c.address)), h('span', null, c.name || c.address, h('span', { class: 'muted' }, ` ${c.address}@doodle.mail`)))));
      chips.appendChild(sugg);
    };
    input.addEventListener('input', () => { if (/[,;\s]$/.test(input.value)) add(input.value); else showSugg(); });
    input.addEventListener('keydown', (e) => {
      if (sugg && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        sIdx = (sIdx + (e.key === 'ArrowDown' ? 1 : -1) + sList.length) % sList.length;
        [...sugg.children].forEach((b, i) => b.classList.toggle('on', i === sIdx));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (sugg && sList[sIdx]) { e.preventDefault(); add(sList[sIdx].address); hideSugg(); return; }
        if (input.value.trim()) { e.preventDefault(); add(input.value); return; }
      }
      if (e.key === 'Backspace' && !input.value && rec[key].length) { rec[key].pop(); render(); changed(); }
    });
    input.addEventListener('blur', () => { setTimeout(hideSugg, 120); if (input.value.trim()) add(input.value); });
    input.addEventListener('paste', (e) => { const t = e.clipboardData.getData('text'); if (/[\s,;]/.test(t.trim())) { e.preventDefault(); add(t); } });
    row.addEventListener('click', (e) => { if (e.target === row || e.target === chips) input.focus(); });
    function render() {
      clear(chips);
      rec[key].forEach((a, i) => {
        const bad = a.startsWith('!');
        chips.appendChild(h('span', { class: 'rchip' + (bad ? ' bad' : ''), title: bad ? 'Not a valid doodle address' : `${a}@doodle.mail` },
          bad ? a.slice(1) : (a === S.account.address ? `${a} (me)` : a),
          h('button', { type: 'button', 'aria-label': `Remove ${a}`, onclick: () => { rec[key].splice(i, 1); render(); changed(); } }, icon('x'))));
      });
      chips.appendChild(input);
    }
    return { row, input, render, flush: () => { if (input.value.trim()) add(input.value); } };
  }

  async function addFiles(list) {
    const files = [...list];
    let total = rec.attachments.reduce((s, a) => s + a.size, 0);
    for (const f of files) {
      if (rec.attachments.length >= 20) { toast('Up to 20 attachments per letter.'); break; }
      if (total + f.size > MAX_TOTAL) { toast(`"${f.name}" won't fit — letters can carry up to 25 MB.`); continue; }
      total += f.size;
      rec.attachments.push(await storeFile(f));
    }
    sync(); changed();
  }

  function htmlSnippet() {
    const name = h('input', { class: 'input', value: 'page.html', maxlength: 80 });
    const code = h('textarea', { class: 'textarea', spellcheck: 'false', placeholder: '<h1>Hello!</h1>\n<button onclick="this.textContent=\'clicked!\'">click me</button>' });
    modal({
      title: 'Attach an HTML page', iconName: 'code', className: 'html-snippet-modal', wide: true,
      body: [h('div', { class: 'hint' }, 'Recipients see it as a live, interactive preview inside a locked sandbox (no network, no access to their mail).'),
        h('div', { class: 'field' }, h('label', null, 'File name'), name), h('div', { class: 'field' }, h('label', null, 'HTML'), code)],
      actions: [{ label: 'Cancel' }, { label: 'Attach', primary: true, icon: 'clip', onClick: async () => {
        if (!code.value.trim()) return false;
        let n = name.value.trim() || 'page.html';
        if (!/\.html?$/i.test(n)) n += '.html';
        await addFiles([new File([code.value], n, { type: 'text/html' })]);
      } }],
    });
  }

  function sigMenu(anchor) {
    openMenu(anchor, [
      { head: 'Signature' },
      { label: 'No signature', icon: rec.sigId ? null : 'check', onClick: () => { rec.sigId = null; sync(); changed(); } },
      ...S.settings.signatures.map(s => ({ label: s.name, icon: rec.sigId === s.id ? 'check' : null, onClick: () => { rec.sigId = s.id; sync(); changed(); } })),
      'sep',
      { label: 'Manage signatures…', icon: 'gear', onClick: () => { location.hash = '#/settings/signatures'; } },
    ], { align: 'left' });
  }

  const isEmpty = () => !rec.to.length && !rec.cc.length && !rec.bcc.length && !rec.subject.trim() && !rec.text.trim() && !rec.attachments.length;
  const save = async () => {
    if (destroyed || !rec.draft) return;
    if (isEmpty() && !savedAt) return;
    rec.date = rec.sortDate = Date.now();
    await saveMsg({ ...rec, to: [...rec.to], cc: [...rec.cc], bcc: [...rec.bcc], attachments: [...rec.attachments] });
    savedAt = Date.now(); dirty = false;
    savedEl.textContent = 'Draft saved';
  };
  const saveSoon = debounce(save, 900);
  function changed() { dirty = true; savedEl.textContent = ''; saveSoon(); }

  function toggleMin(force) {
    const min = force ?? !el.classList.contains('min');
    el.classList.toggle('min', min);
    if (min) el.classList.remove('max');
  }

  function destroy() { destroyed = true; el.remove(); open.delete(rec.id); }

  async function close() {
    toField.flush(); ccField.flush(); bccField.flush();
    if (dirty || !savedAt) await save();
    const wasSaved = savedAt;
    destroy();
    if (wasSaved && !isEmpty()) toast('Draft saved', { action: 'Open', onAction: () => openCompose({ draftId: rec.id }) });
  }

  async function discard() {
    destroy();
    if (S.msgs.has(rec.id)) await deleteForever([rec.id]);
    else for (const a of rec.attachments) await S.db.blobs.delete(a.id);
    toast('Draft discarded');
  }

  async function send() {
    toField.flush(); ccField.flush(); bccField.flush();
    const all = [...rec.to, ...rec.cc, ...rec.bcc];
    if (!all.length) { toast('Add at least one recipient.'); toField.input.focus(); return; }
    const bad = all.filter(a => a.startsWith('!'));
    if (bad.length) { toast(`"${bad[0].slice(1)}" isn't a valid address.`); return; }
    if (all.length > 50) { toast('Up to 50 recipients per letter.'); return; }
    sendBtn.disabled = true;
    await save();
    if (!S.msgs.has(rec.id)) await saveMsg(rec);
    destroy();
    const secs = Number(S.settings.undoSeconds) || 0;
    const go = async () => {
      const m = S.msgs.get(rec.id);
      if (!m || !m.draft) return;
      await sendDraft(m);
      const online = S.status === 'online';
      toast(online ? 'Letter on its way' : 'Queued in Outbox — will send when you are back online', { action: 'View', onAction: () => { location.hash = `#/f/sent/m/${m.id}`; } });
    };
    if (!secs) return go();
    let undone = false;
    const timer = setTimeout(() => { if (!undone) go(); }, secs * 1000);
    toast('Sending…', { action: 'Undo', timeout: secs * 1000, onAction: () => { undone = true; clearTimeout(timer); openCompose({ draftId: rec.id }); } });
    emit('msgs');
  }

  function focus(where) {
    toggleMin(false);
    (where === 'body' || rec.to.length ? body : toField.input).focus();
    if (where === 'body') { body.setSelectionRange(0, 0); body.scrollTop = 0; }
  }

  sync();
  return { el, focus, destroy, minimize: (v) => toggleMin(v) };
}
