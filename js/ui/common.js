// Menus, modals, toasts, empty-state doodles.
import { h, icon, clear } from '../util.js';

// ---------- toasts ----------
export function toast(text, { action, onAction, timeout = 4200 } = {}) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: 'toast' }, h('span', null, text));
  let done = false;
  const close = () => { if (done) return; done = true; t.style.opacity = '0'; t.style.transition = 'opacity .2s'; setTimeout(() => t.remove(), 220); };
  if (action) t.appendChild(h('button', { onclick: () => { close(); onAction?.(); } }, action));
  t.appendChild(h('button', { 'aria-label': 'Dismiss', onclick: close }, icon('x')));
  host.appendChild(t);
  while (host.children.length > 3) host.firstChild.remove();
  if (timeout) setTimeout(close, timeout);
  return { close };
}

// ---------- menus ----------
let openMenuEl = null;
export function closeMenus() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}
document.addEventListener('pointerdown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('[data-menu-anchor]')) closeMenus();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenuEl) { closeMenus(); e.stopPropagation(); } }, true);
window.addEventListener('resize', closeMenus);

export function openMenu(anchor, items, { align = 'right', width } = {}) {
  const wasOpen = openMenuEl && openMenuEl._anchor === anchor;
  closeMenus();
  if (wasOpen) return null;
  const m = h('div', { class: 'menu sketch', role: 'menu' });
  if (width) m.style.width = width + 'px';
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') { m.appendChild(h('div', { class: 'menu-sep' })); continue; }
    if (it instanceof Node) { m.appendChild(it); continue; }
    if (it.head) { m.appendChild(h('div', { class: 'menu-head' }, it.head)); continue; }
    m.appendChild(h('button', {
      class: 'menu-item', role: 'menuitem', disabled: it.disabled,
      onclick: (e) => { if (!it.keepOpen) closeMenus(); it.onClick?.(e); },
    }, it.icon ? icon(it.icon) : h('span', { class: 'ic' }), h('span', null, it.label), it.right ? h('span', { class: 'right' }, it.right) : null));
  }
  m._anchor = anchor;
  document.body.appendChild(m);
  openMenuEl = m;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  let top = r.bottom + 6;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  m.querySelector('.menu-item, input')?.focus({ preventScroll: true });
  m.addEventListener('keydown', (e) => {
    const btns = [...m.querySelectorAll('.menu-item:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  });
  return m;
}

// ---------- modals ----------
export function modal({ title, iconName, body, actions = [], wide, onClose, className = '' }) {
  const prevFocus = document.activeElement;
  const card = h('div', { class: `modal sketch ${wide ? 'wide' : ''} ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const ov = h('div', { class: 'overlay' }, card);
  const close = (v) => {
    ov.remove();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.({ preventScroll: true });
    onClose?.(v);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
  card.appendChild(h('h2', null, iconName ? icon(iconName) : null, title));
  if (body) card.appendChild(h('div', { class: 'stack' }, body));
  if (actions.length) {
    card.appendChild(h('div', { class: 'modal-actions' }, actions.map(a => h('button', {
      class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`, type: 'button',
      onclick: async () => { const r = await a.onClick?.(); if (r !== false) close(a.value ?? r); },
    }, a.icon ? icon(a.icon) : null, a.label))));
  }
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(null); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(ov);
  setTimeout(() => (card.querySelector('input, textarea, select') || card.querySelector('.btn.primary') || card).focus?.(), 30);
  return { close, el: card };
}

export function confirmDialog(title, text, okLabel = 'OK', { danger, iconName } = {}) {
  return new Promise((resolve) => {
    modal({
      title, iconName, body: h('p', { class: 'terms-text' }, text),
      actions: [{ label: 'Cancel', value: false }, { label: okLabel, primary: !danger, danger, value: true }],
      onClose: (v) => resolve(!!v),
    });
  });
}

export function promptDialog(title, label, value = '', { placeholder = '', okLabel = 'Save', iconName } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder, maxlength: 60 });
    const m = modal({
      title, iconName,
      body: h('div', { class: 'field' }, h('label', null, label), input),
      actions: [{ label: 'Cancel', value: null, onClick: () => null }, { label: okLabel, primary: true, onClick: () => input.value.trim() || false }],
      onClose: (v) => resolve(v || null),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) { m.close(input.value.trim()); } });
  });
}

// ---------- doodles ----------
const DOODLES = {
  inbox: `<svg class="doodle" viewBox="0 0 140 110" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 62 L34 30 Q36 26 41 26 H99 Q104 26 106 30 L118 62 V88 Q118 94 112 94 H28 Q22 94 22 88 Z"/><path d="M22 62 H48 Q51 74 70 74 Q89 74 92 62 H118"/><path d="M58 14 L60 20 M70 8 V16 M82 14 L80 20"/><path d="M118 20 l3 6 6 1 -5 4 1 6 -5 -3 -5 3 1 -6 -5 -4 6 -1 z"/></svg>`,
  reader: `<svg class="doodle" viewBox="0 0 200 150" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M40 66 L100 24 L160 66 V124 Q160 130 154 130 H46 Q40 130 40 124 Z"/><path d="M58 52 V34 H142 V52"/><path d="M41 67 L100 104 L159 67"/><path d="M20 136 H180" stroke-dasharray="3 6"/></svg>`,
  search: `<svg class="doodle" viewBox="0 0 140 110" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M60 18 Q88 19 89 47 Q88 75 60 76 Q32 75 31 47 Q32 19 60 18 Z"/><path d="M80 68 L106 94"/><path d="M52 40 Q53 32 61 32 Q69 33 69 40 Q68 45 62 47 Q60 49 60 53"/><circle cx="60" cy="61" r="1" fill="currentColor"/></svg>`,
  sent: `<svg class="doodle" viewBox="0 0 140 110" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M118 20 L22 56 L58 66 L70 96 Z"/><path d="M118 20 L58 66"/><path d="M30 92 Q14 80 24 70" stroke-dasharray="3 5"/></svg>`,
};
const tpl = document.createElement('template');
export function doodle(name) { tpl.innerHTML = DOODLES[name] || DOODLES.inbox; return tpl.content.firstElementChild.cloneNode(true); }

export function emptyState(name, big, small) {
  return h('div', { class: 'empty' }, doodle(name), h('div', { class: 'big' }, big), small ? h('div', null, small) : null);
}

export { clear };
