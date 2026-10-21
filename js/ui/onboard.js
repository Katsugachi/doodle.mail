// Sign-up / sign-in screen.
import { h, icon, clear, debounce, uuid } from '../util.js';
import { listAccounts, upsertAccount, defaultSettings } from '../state.js';
import { normalizeAddress, checkAvailability } from '../net.js';
import { generateIdentity } from '../crypto.js';
import { openDB } from '../db.js';
import { importBackup } from '../backup.js';
import { modal, toast } from './common.js';
import { termsBody } from './terms.js';
import { welcomeMessage } from './welcome.js';

export function renderOnboard(root, { onReady }) {
  clear(root);
  root.className = 'onboard';
  const accounts = listAccounts();
  let tab = accounts.length ? 'signin' : 'signup';

  const art = h('div', { class: 'onboard-art' },
    h('div', { class: 'brand-big' }, icon('logo'), h('span', null, 'doodle.mail')),
    h('div', { class: 'tagline' }, 'Little letters, passed hand to hand. No servers keep your mail — it lives in your notebook.'),
    h('ul', null,
      h('li', null, icon('send'), 'Peer-to-peer delivery over WebRTC'),
      h('li', null, icon('outbox'), 'Queued until your friend comes online'),
      h('li', null, icon('shield'), 'Signed messages, pinned sender keys'),
      h('li', null, icon('code'), 'Send HTML that renders — safely sandboxed'),
      h('li', null, icon('clip'), 'Images, zips & files up to 25 MB'),
    ));
  const form = h('div', { class: 'onboard-form' });
  const card = h('div', { class: 'onboard-card sketch' }, art, form);
  root.appendChild(card);

  function draw() {
    clear(form);
    form.appendChild(h('div', { class: 'tabs-line', role: 'tablist' },
      accounts.length ? h('button', { class: tab === 'signin' ? 'on' : '', role: 'tab', onclick: () => { tab = 'signin'; draw(); } }, 'Sign in') : null,
      h('button', { class: tab === 'signup' ? 'on' : '', role: 'tab', onclick: () => { tab = 'signup'; draw(); } }, 'Sign up'),
      h('button', { class: tab === 'restore' ? 'on' : '', role: 'tab', onclick: () => { tab = 'restore'; draw(); } }, 'Restore')));
    if (tab === 'signin') drawSignin();
    else if (tab === 'restore') drawRestore();
    else drawSignup();
  }

  function finish(address) { onReady(address); }

  function drawSignin() {
    form.append(
      h('h1', null, 'Welcome back'),
      h('div', { class: 'hint' }, 'These addresses live in this browser. Pick one to open it.'),
      h('div', { class: 'account-pick' }, accounts.map(a => h('button', { onclick: () => finish(a.address) },
        h('div', { class: 'avatar' }, (a.name || a.address)[0].toUpperCase()),
        h('div', null, h('div', null, a.name || a.address), h('div', { class: 'hint' }, `${a.address}@doodle.mail`)),
        h('span', { style: { marginLeft: 'auto' } }, icon('chevronRight'))))),
    );
  }

  function drawRestore() {
    const input = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', id: 'restore-file' });
    const status = h('div', { class: 'hint' });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      if (!f) return;
      status.textContent = 'Restoring…';
      try { finish(await importBackup(f)); } catch (e) { status.textContent = e.message || 'Could not read that backup.'; }
    });
    form.append(
      h('h1', null, 'Restore a backup'),
      h('div', { class: 'hint' }, 'Bring your address, keys and mail over from another browser using a backup exported from Settings → Account.'),
      h('label', { class: 'btn', for: 'restore-file' }, icon('upload'), 'Choose backup file…'), input, status);
  }

  function drawSignup() {
    const name = h('input', { class: 'input', id: 'su-name', autocomplete: 'name', maxlength: 40, placeholder: 'Maya Chen' });
    const addr = h('input', { id: 'su-addr', autocomplete: 'off', spellcheck: 'false', maxlength: 24, placeholder: 'maya', 'aria-describedby': 'su-addr-status' });
    const status = h('div', { class: 'addr-status', id: 'su-addr-status', 'aria-live': 'polite' });
    const tos = h('input', { type: 'checkbox', id: 'su-tos' });
    const submit = h('button', { class: 'btn primary', type: 'submit', disabled: true }, icon('pencil'), 'Create my address');
    let touched = false, availability = 'unknown', checkSeq = 0;

    const setStatus = (ic, text) => { clear(status); if (ic) status.appendChild(icon(ic)); status.appendChild(h('span', null, text)); };
    const validate = () => {
      const handle = normalizeAddress(addr.value);
      const ok = !!handle && name.value.trim().length > 0 && tos.checked && availability !== 'taken' && availability !== 'local' && availability !== 'checking';
      submit.disabled = !ok;
      return handle;
    };
    const check = debounce(async () => {
      const handle = normalizeAddress(addr.value);
      const seq = ++checkSeq;
      if (!addr.value.trim()) { availability = 'unknown'; clear(status); validate(); return; }
      if (!handle) { availability = 'invalid'; setStatus('alert', '3–24 characters: letters, numbers, - or _ (start and end with a letter/number)'); validate(); return; }
      if (listAccounts().some(a => a.address === handle)) { availability = 'local'; setStatus('alert', 'You already have this address in this browser.'); validate(); return; }
      availability = 'checking'; setStatus('refresh', `Checking ${handle}@doodle.mail…`); validate();
      const r = await checkAvailability(handle);
      if (seq !== checkSeq) return;
      availability = r;
      if (r === 'available') setStatus('check', `${handle}@doodle.mail looks free`);
      else if (r === 'taken') setStatus('ban', 'Someone is using that address right now — try another');
      else setStatus('wifi', "Couldn't reach the signalling server; you can still create it offline");
      validate();
    }, 450);

    addr.addEventListener('input', () => {
      const v = addr.value.toLowerCase().replace(/\s+/g, '');
      if (v !== addr.value) addr.value = v;
      touched = true; availability = 'checking'; validate(); check();
    });
    name.addEventListener('input', () => {
      if (!touched) {
        addr.value = name.value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
        if (addr.value) { availability = 'checking'; check(); }
      }
      validate();
    });
    tos.addEventListener('change', validate);

    const terms = h('button', { type: 'button', class: 'link-btn', onclick: () => modal({ title: 'Terms of Service', iconName: 'file', body: termsBody(), wide: true, actions: [{ label: 'Close' }, { label: 'I agree', primary: true, onClick: () => { tos.checked = true; validate(); } }] }) }, 'Terms of Service');

    const f = h('form', { class: 'stack', style: { display: 'grid', gap: '16px' }, novalidate: true },
      h('div', { class: 'field' }, h('label', { for: 'su-name' }, 'Your name'), name),
      h('div', { class: 'field' }, h('label', { for: 'su-addr' }, 'Pick an address'),
        h('div', { class: 'addr-input' }, addr, h('span', { class: 'suffix' }, '@doodle.mail')), status),
      h('label', { class: 'check', for: 'su-tos' }, tos, h('span', null, 'I have read and agree to the ', terms, '. I understand my mail is stored only on this device and delivered peer-to-peer.')),
      h('div', null, submit),
      h('div', { class: 'hint' }, 'No password, no tracking. Your identity key is created and kept in this browser.'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const handle = validate();
      if (submit.disabled || !handle) return;
      submit.disabled = true;
      submit.lastChild.textContent = 'Sharpening pencils…';
      try {
        await createAccount(handle, name.value.trim());
        finish(handle);
      } catch (err) {
        console.error(err);
        toast('Could not create the account: ' + (err.message || err));
        submit.disabled = false; submit.lastChild.textContent = 'Create my address';
      }
    });
    form.append(h('h1', null, 'Create your account'), f);
    setTimeout(() => name.focus(), 50);
  }

  draw();
}

async function createAccount(address, name) {
  const identity = await generateIdentity();
  const db = await openDB(address);
  await db.kv.set('identity', identity);
  const settings = defaultSettings(name);
  localStorage.setItem(`doodlemail:settings:${address}`, JSON.stringify(settings));
  const { msg, blob } = welcomeMessage(address, name, uuid);
  await db.blobs.put(msg.attachments[0].id, blob);
  await db.messages.put(msg);
  db.close();
  upsertAccount({ address, name, createdAt: Date.now() });
}
