# doodle.mail

A notebook-doodle, monochrome, Gmail-style mail app where messages travel **peer-to-peer over WebRTC**. It's a fully static site with no build step, no backend and no database server, so it runs as-is on GitHub Pages. Every account, message and attachment is stored locally in the browser.

## Features

- **Addresses**: sign up as `you@doodle.mail` (first come, first served among online peers). You must tick the Terms of Service box to sign up.
- **P2P delivery**: [PeerJS](https://peerjs.com) handles signalling, and messages go over encrypted WebRTC data channels. Each letter is signed with your ECDSA P-256 key. Recipients pin your key the first time they see it (trust-on-first-use) and get a warning if it ever changes.
- **Offline queueing**: if the recipient isn't online, the letter waits in the **Outbox** and retries with backoff. It is delivered as soon as you're both online, and the queue flushes immediately whenever that peer connects. You can also cancel a queued letter and edit it again.
- **Folders**: Inbox, Starred, Snoozed, Important, Sent, Outbox, Drafts, All Mail, Spam, Bin (auto-purged after 30 days), plus custom **labels**.
- **Compose**: To / **Cc** / **Bcc** (each Bcc recipient gets their own copy), multiple **signatures**, auto-saved drafts, undo send, drag-and-drop or pasted **images, zips and any files** (up to 25 MB per letter), and an **HTML page** attachment.
- **Interactive HTML previews**: HTML attachments render live in a sandboxed iframe (`sandbox="allow-scripts allow-forms"`, opaque origin) with a strict CSP (`default-src 'none'`, no network, no forms, no navigation or popups). Scripts can run, but they can't reach the app, your storage or the internet.
- **Reading**: threaded conversations, quick reply with an emoji picker, **copy**, **print**, **download as .eml**, download attachments, image lightbox.
- **Bulk actions**: **mark all as read**, select, star, label, snooze, archive, spam, bin.
- **Spam & blocking**: block senders, optionally send strangers to Spam, and auto-spam letters with bad or changed signatures.
- **Settings**: light/dark/system theme, inbox **density** (comfortable/default/compact), notifications, shortcuts, a custom PeerJS server and STUN/TURN, backup export/import, persistent storage, and account deletion.
- **Cat**: the sidebar cat wanders around, sits and watches your cursor, and naps. Click it to pet it. It respects `prefers-reduced-motion`.
- Responsive layout with a mobile drawer, keyboard shortcuts (press `?`), and a strict page CSP (`script-src 'self'`, no inline script or style).

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

You need a real HTTP origin because ES modules and IndexedDB don't work over `file://`. To try a conversation, open the app in two different browser profiles (or one normal and one private window) and create a different address in each.

## Deploy to GitHub Pages

This repo includes `.github/workflows/pages.yml`. In **Settings → Pages**, set **Source** to **GitHub Actions**, then push to `main`. You can also choose "Deploy from a branch" (root): the site is plain static files and `.nojekyll` is included.

> GitHub Pages for **private** repositories requires a paid GitHub plan. To use the free tier, make the repo public.

## How it works

| Piece | File |
| --- | --- |
| App shell, routing, list, shortcuts | `js/app.js` |
| State, folders, search operators | `js/state.js` |
| Sending, receiving, reply/forward, .eml export | `js/mail.js` |
| WebRTC transport, signatures, TOFU, outbox queue | `js/net.js` |
| ECDSA signing, canonical JSON | `js/crypto.js` |
| IndexedDB storage | `js/db.js` |
| Sandboxed HTML preview | `js/htmlpreview.js`, `sandbox.html` |
| UI: compose, reader, settings, onboarding | `js/ui/*` |
| The cat | `js/cat.js` |

**Limits.** Delivery only happens while both browsers are open. The default signalling server is the free public PeerJS cloud: for reliability or privacy, self-host [peerjs-server](https://github.com/peers/peerjs-server) and set it in Settings → Network (everyone you write to must use the same server). Some strict networks need a TURN server. Addresses aren't globally reserved: anyone can claim an address while its owner is offline, which is why sender keys are pinned and key changes are flagged.

## Tests

`tests/run_tests.py` runs browser tests with Playwright and Chrome against the real PeerJS cloud. They cover crypto, the HTML sandbox and two-peer delivery: queueing, retry, 10 MB attachments, tampering, reload persistence and cancellation.

```sh
pip install playwright
python3 -m http.server 8765 &
python3 tests/run_tests.py
```

## Credits

Font: Patrick Hand (SIL OFL 1.1, `fonts/OFL.txt`). PeerJS (MIT, `vendor/LICENSE-peerjs`).
