// Small DOM + formatting helpers. All user-provided strings go through text nodes.
import { ICONS } from './icons.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) append(el, kid);
    else if (kid instanceof Node) el.appendChild(kid);
    else el.appendChild(document.createTextNode(String(kid)));
  }
}

const iconTpl = document.createElement('template');
export function icon(name, cls = '') {
  // ICONS are static, trusted strings shipped with the app.
  iconTpl.innerHTML = ICONS[name] || ICONS.dot;
  const svg = iconTpl.content.firstElementChild.cloneNode(true);
  svg.setAttribute('class', 'ic ' + cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const x = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

const DAY = 86400000;
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function fmtListDate(t) {
  const now = Date.now();
  const d = new Date(t);
  if (t >= startOfDay(now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (t >= startOfDay(now) - DAY) return 'Yesterday';
  if (t >= startOfDay(now) - 6 * DAY) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString();
}

export function fmtFullDate(t) {
  return new Date(t).toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function dayBucket(t) {
  const today = startOfDay(Date.now());
  if (t >= today) return 'Today';
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return 'This week';
  return 'Earlier';
}

export function debounce(fn, ms) {
  let tm;
  return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); };
}

export function initial(name, address) {
  const s = (name || address || '?').trim();
  return (s[0] || '?').toUpperCase();
}

export function download(blob, filename) {
  // Never navigate to blob URLs of untrusted content; force a download.
  const safe = new Blob([blob], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(safe);
  const a = h('a', { href: url, download: filename || 'download', rel: 'noopener' });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeFilename(name) {
  return (name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'file';
}

export function fileKind(name = '', type = '') {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (/^(html?|xhtml)$/.test(ext) || type === 'text/html') return 'html';
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(type) || /^(png|jpe?g|gif|webp|avif|bmp)$/.test(ext)) return 'image';
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz)$/.test(ext) || /zip|compressed|x-tar|gzip/.test(type)) return 'zip';
  if (/^(pdf)$/.test(ext)) return 'pdf';
  if (/^(mp3|wav|ogg|m4a|flac)$/.test(ext)) return 'audio';
  if (/^(mp4|webm|mov|mkv)$/.test(ext)) return 'video';
  if (/^(txt|md|csv|json|log|js|ts|css|py|xml|yml|yaml)$/.test(ext)) return 'text';
  return 'file';
}

// Turns plain text into nodes, linkifying http(s) URLs only.
export function linkify(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    let href = m[0];
    try { href = new URL(href).href; } catch { out.push(document.createTextNode(m[0])); last = re.lastIndex; continue; }
    out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, m[0]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

export function snippet(text, n = 120) {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

export function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
