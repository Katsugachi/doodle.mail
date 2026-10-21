// The seeded welcome letter (with an interactive HTML card to show off sandboxed previews).
const CARD = `<!doctype html>
<html><head><meta charset="utf-8"><title>Welcome card</title>
<style>
  body { margin: 0; font-family: "Comic Sans MS", "Bradley Hand", cursive; background: #f6f5f0; color: #222; display: grid; place-items: center; min-height: 100vh; }
  .card { border: 2px solid #222; border-radius: 22px 26px 20px 24px; padding: 26px 30px; max-width: 360px; text-align: center; box-shadow: 4px 5px 0 -1px #2224; background: #fff; }
  h1 { font-weight: normal; margin: 0 0 8px; font-size: 28px; }
  button { font: inherit; font-size: 18px; border: 2px solid #222; background: #222; color: #fff; padding: 8px 18px; border-radius: 14px 18px 15px 17px; cursor: pointer; }
  button:active { transform: translateY(1px); }
  .stars { font-size: 28px; min-height: 36px; letter-spacing: 4px; }
  input { font: inherit; border: 0; border-bottom: 2px dashed #222; text-align: center; background: none; width: 180px; padding: 4px; outline: none; }
</style></head>
<body><div class="card">
  <h1>Hello, <span id="who">friend</span>!</h1>
  <p>This card is an <b>HTML file</b> rendering inside a locked sandbox. It can run scripts, but it can't touch your mail or the internet.</p>
  <p><input id="name" placeholder="type your name"></p>
  <div class="stars" id="stars"></div>
  <button id="btn">collect a star</button>
</div>
<script>
  var n = 0;
  document.getElementById('btn').onclick = function () { n++; document.getElementById('stars').textContent = '\\u2605'.repeat(n % 9); };
  document.getElementById('name').oninput = function (e) { document.getElementById('who').textContent = e.target.value || 'friend'; };
</script></body></html>`;

export function welcomeMessage(address, name, uuid) {
  const now = Date.now();
  const attId = uuid();
  const blob = new Blob([CARD], { type: 'application/octet-stream' });
  const msg = {
    id: uuid(), mid: uuid(), threadId: uuid(), inReplyTo: null,
    from: { address: 'team', name: 'Team Doodle' }, to: [address], cc: [], bcc: [],
    subject: 'Welcome to doodle.mail!',
    text: `Hi ${name || 'there'},

Welcome to your new notebook! Your address is ${address}@doodle.mail — share it with friends so they can write to you.

A few things worth knowing:

• Mail travels straight from browser to browser over WebRTC. If your friend isn't online, your letter waits in the Outbox and is delivered automatically the moment you're both around.
• Everything is saved only in this browser. Export a backup from Settings → Account if you'd like a copy.
• Every letter is signed with your personal key, so friends can tell it's really you.
• Attach images, zips or any file up to 25 MB. HTML files render as live previews in a locked sandbox — try the card below!
• Make it yours in Settings: signatures, labels, light/dark theme and inbox density.

Happy doodling,
Team Doodle`,
    attachments: [{ id: attId, name: 'welcome-card.html', type: 'text/html', size: blob.size }],
    date: now, sortDate: now, receivedAt: now, dir: 'in', draft: false,
    read: false, starred: false, important: true, labels: [], loc: 'inbox', snoozeUntil: null,
    verified: 'system',
  };
  return { msg, blob };
}
