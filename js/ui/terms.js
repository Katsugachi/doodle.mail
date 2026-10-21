import { h } from '../util.js';

export function termsBody() {
  const sec = (t, ...ps) => [h('h3', null, t), ...ps.map(p => h('p', null, p))];
  return h('div', { class: 'terms-text' },
    h('p', null, 'Last updated: October 2026. By creating a doodle.mail address you agree to these terms.'),
    sec('1. What doodle.mail is',
      'doodle.mail is a static web app that runs entirely in your browser. Messages travel directly between browsers over encrypted WebRTC data channels. A public signalling server (PeerJS by default, or one you configure) is used only to help two browsers find each other; it never receives message contents.'),
    sec('2. Your data stays on your device',
      'Your address, identity key, settings, messages and attachments are stored in this browser (IndexedDB and localStorage). We do not run servers that store or back up your mail. Clearing site data, using private browsing, or losing the device will delete it. Export a backup from Settings → Account if it matters to you.'),
    sec('3. Addresses',
      'Addresses are first-come, first-served among people who are online, and are tied to a signing key generated on your device. Recipients pin the first key they see for an address and warn if it ever changes. Do not impersonate others or claim addresses to mislead people.'),
    sec('4. Delivery',
      'Mail is delivered only when both people are online. Until then it waits in your Outbox and retries automatically. Delivery is best-effort; there is no guarantee a message will ever arrive.'),
    sec('5. Acceptable use',
      'Do not use doodle.mail to send spam, malware, illegal content, harassment, or content you do not have the right to share. HTML attachments are rendered in a locked sandbox without network access, but you should still only open files from people you trust.'),
    sec('6. No warranty',
      'doodle.mail is provided "as is", without warranty of any kind. To the maximum extent permitted by law, the authors are not liable for any loss of data, missed messages or damages arising from its use.'),
    sec('7. Changes', 'These terms may change as the project evolves. Continuing to use the app after changes means you accept the updated terms.'));
}
