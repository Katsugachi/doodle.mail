#!/usr/bin/env python3
"""Browser tests for doodle.mail's crypto, transport, and HTML preview modules."""

import argparse
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
CHROME = "/home/ubuntu/.local/bin/google-chrome"


def wait_until_ready(url, server):
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError("python http.server exited before becoming ready")
        try:
            with urllib.request.urlopen(url, timeout=1):
                return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("python http.server did not become ready")


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def random_handle(prefix):
    import secrets

    return f"{prefix}{secrets.token_hex(4)}z"


def test_crypto(browser, base_url):
    page = browser.new_page()
    page.goto(f"{base_url}/tests/crypto-harness.html")
    page.wait_for_function("window.harnessReady === true")
    result = page.evaluate("window.cryptoTests()")
    assert_true(result["roundtrip"], "ECDSA signature did not verify")
    assert_true(not result["tampered"], "Tampered envelope verified")
    assert_true(result["canonicalOrderIndependent"], "Canonical JSON depends on key order")
    assert_true(
        len(result["fingerprint"].split()) == 4,
        f"Unexpected fingerprint format: {result['fingerprint']}",
    )
    print("PASS crypto: ECDSA sign/verify, tamper rejection, canonical key order")
    page.close()


def test_htmlpreview(browser, base_url):
    page = browser.new_page()
    page.goto(f"{base_url}/tests/htmlpreview-harness.html")
    page.wait_for_function("window.harnessReady === true")
    page.evaluate("localStorage.setItem('preview-parent-sentinel', 'unchanged')")
    page.evaluate("document.cookie = 'preview-parent-cookie=secret; SameSite=Lax; path=/'")
    starting_url = page.url
    preview_html = """
      <!doctype html><html><body>
        <button id="go" onclick="document.querySelector('#status').textContent='clicked'">Run</button>
        <p id="status">ready</p>
        <img id="external" src="https://example.com/x.png">
        <form id="external-form" action="https://example.com/" method="post">
          <input name="x" value="y"><button type="submit">Submit</button>
        </form>
        <script>
          window.scriptRan = true;
          window.previewCsp = [];
          document.addEventListener('securitypolicyviolation', event => {
            window.previewCsp.push(event.effectiveDirective);
          });
        </script>
      </body></html>
    """
    page.evaluate("(html) => window.renderTestPreview(html)", preview_html)
    frame_element = page.locator("iframe.html-preview-frame")
    frame_element.wait_for()
    frame = page.frame_locator("iframe.html-preview-frame")
    frame.locator("#status").wait_for()
    frame.locator("#go").click()
    assert_true(frame.locator("#status").inner_text() == "clicked", "Sandboxed button handler did not run")

    attributes = frame_element.evaluate(
        """frame => ({
          sandbox: frame.getAttribute('sandbox'),
          referrerpolicy: frame.getAttribute('referrerpolicy'),
          allow: frame.getAttribute('allow'),
          loading: frame.getAttribute('loading'),
          title: frame.title,
          className: frame.className,
          height: frame.height
        })"""
    )
    assert_true(attributes["sandbox"] == "allow-scripts allow-forms", "Unexpected iframe sandbox")
    assert_true(attributes["referrerpolicy"] == "no-referrer", "Unexpected referrer policy")
    assert_true(attributes["allow"] == "", "Iframe permissions were not disabled")
    assert_true(attributes["loading"] == "lazy", "Iframe is not lazy-loaded")
    assert_true(attributes["title"] == "HTML preview (sandboxed)", "Unexpected iframe title")
    assert_true(attributes["className"] == "html-preview-frame", "Unexpected iframe class")
    assert_true(attributes["height"] == "480", "Unexpected default preview height")

    frame_result = page.frame_locator("iframe.html-preview-frame").locator("body").evaluate(
        """async body => {
          let parentDocumentBlocked = false;
          try { void parent.document; } catch { parentDocumentBlocked = true; }
          let localStorageBlocked = false;
          try { localStorage.getItem('preview-parent-sentinel'); } catch { localStorageBlocked = true; }
          let cookie = '';
          let cookieReadBlocked = false;
          try { cookie = document.cookie; } catch { cookieReadBlocked = true; }
          const fetchBlocked = await fetch('https://example.com/')
            .then(() => false, () => true);
          let topNavigationBlocked = false;
          try { top.location = 'https://example.com/'; } catch { topNavigationBlocked = true; }
          const popupBlocked = window.open('https://example.com/', '_blank') === null;
          const image = document.querySelector('#external');
          await new Promise(resolve => {
            if (image.complete) resolve();
            else {
              image.addEventListener('error', resolve, { once: true });
              image.addEventListener('load', resolve, { once: true });
              setTimeout(resolve, 1500);
            }
          });
          document.querySelector('#external-form').requestSubmit();
          await new Promise(resolve => setTimeout(resolve, 300));
          return {
            scriptRan: window.scriptRan === true,
            parentDocumentBlocked,
            localStorageBlocked,
            cookie,
            cookieReadBlocked,
            fetchBlocked,
            topNavigationBlocked,
            popupBlocked,
            imageFailed: image.naturalWidth === 0,
            formActionBlocked: window.previewCsp.includes('form-action'),
            url: location.href
          };
        }"""
    )
    assert_true(frame_result["scriptRan"], "Inline scripts did not run in the preview")
    assert_true(frame_result["parentDocumentBlocked"], "Preview can read parent.document")
    assert_true(frame_result["localStorageBlocked"], "Preview can access localStorage")
    assert_true(
        frame_result["cookieReadBlocked"] or frame_result["cookie"] == "",
        "Opaque-origin preview exposed a cookie",
    )
    assert_true(frame_result["fetchBlocked"], "CSP did not block fetch")
    assert_true(frame_result["topNavigationBlocked"], "Preview could navigate the top-level page")
    assert_true(frame_result["popupBlocked"], "Preview could open a popup")
    assert_true(frame_result["imageFailed"], "CSP did not block external image loading")
    assert_true(frame_result["formActionBlocked"], "CSP did not block form submission")
    assert_true(frame_result["url"] == frame_element.get_attribute("src"), "Form changed the iframe URL")
    assert_true(page.url == starting_url, "Preview changed the parent URL")
    assert_true(
        page.evaluate("localStorage.getItem('preview-parent-sentinel')") == "unchanged",
        "Preview altered the parent page's localStorage",
    )
    assert_true(
        "preview-parent-cookie=secret" in page.evaluate("document.cookie"),
        "Parent test cookie was not present",
    )
    print("PASS htmlpreview: interaction works; origin, network, navigation and forms stay sandboxed")
    page.close()


def test_net(browser, base_url):
    alice = random_handle("a")
    bob = random_handle("b")
    unavailable = random_handle("u")
    alice_context = browser.new_context()
    bob_context = browser.new_context()
    alice_page = alice_context.new_page()
    bob_page = bob_context.new_page()
    browser_errors = []
    for page in (alice_page, bob_page):
        page.on("pageerror", lambda error: browser_errors.append(str(error)))
        page.goto(f"{base_url}/tests/net-harness.html")
        page.wait_for_function("window.harnessReady === true")

    print("NET: waiting for Alice and Bob to register", flush=True)
    alice_page.evaluate("(handle) => window.setupMailbox(handle)", alice)
    bob_page.evaluate("(handle) => window.setupMailbox(handle)", bob)
    alice_page.wait_for_function("window.status === 'online'", timeout=45_000)
    bob_page.wait_for_function("window.status === 'online'", timeout=45_000)

    taken = alice_page.evaluate("(handle) => window.checkAddress(handle)", bob)
    available = alice_page.evaluate("(handle) => window.checkAddress(handle)", unavailable)
    assert_true(taken == "taken", f"Online handle check returned {taken!r}, expected 'taken'")
    assert_true(available == "available", f"Random handle check returned {available!r}, expected 'available'")
    print("NET: availability probes passed", flush=True)

    first_mid = alice_page.evaluate("(recipient) => window.enqueueMail(recipient)", bob)
    bob_page.wait_for_function(
        "(mid) => window.received.some(message => message.mid === mid && message.meta.verified === 'new')",
        arg=first_mid,
        timeout=45_000,
    )
    alice_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'delivered')",
        arg=first_mid,
        timeout=45_000,
    )
    assert_true(
        alice_page.evaluate("(mid) => window.outboxItems().then(items => items.some(item => item.mid === mid))", first_mid)
        is False,
        "Acknowledged outbox item was not deleted",
    )
    print("NET: first delivery and acknowledgement passed", flush=True)

    second_mid = alice_page.evaluate("(recipient) => window.enqueueMail(recipient)", bob)
    bob_page.wait_for_function(
        "(mid) => window.received.some(message => message.mid === mid && message.meta.verified === 'ok')",
        arg=second_mid,
        timeout=45_000,
    )
    alice_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'delivered')",
        arg=second_mid,
        timeout=45_000,
    )
    print("NET: TOFU repeat delivery passed", flush=True)

    attachment_id = f"{alice}-ten-mib"
    expected_hash = alice_page.evaluate(
        "(id) => window.addBlob(id, 10 * 1024 * 1024)",
        attachment_id,
    )
    attachment_mid = alice_page.evaluate(
        """({recipient, id}) => window.enqueueMail(recipient, {
          attachments: [{
            id,
            name: 'ten-mib.bin',
            type: 'application/octet-stream',
            size: 10 * 1024 * 1024
          }]
        })""",
        {"recipient": bob, "id": attachment_id},
    )
    print("NET: 10 MiB attachment queued; waiting for receiver", flush=True)
    try:
        bob_page.wait_for_function(
            "(mid) => window.received.some(message => message.mid === mid)",
            arg=attachment_mid,
            timeout=120_000,
        )
    except Exception:
        print(
            "NET attachment diagnostic:",
            {
                "aliceDeliveries": alice_page.evaluate("window.deliveries"),
                "aliceOutbox": alice_page.evaluate("window.outboxItems()"),
                "bobReceived": bob_page.evaluate("window.received"),
                "bobStatus": bob_page.evaluate("window.status"),
                "pageErrors": browser_errors,
            },
            flush=True,
        )
        raise
    received_hashes = bob_page.evaluate(
        "(mid) => window.received.find(message => message.mid === mid).attachmentHashes",
        attachment_mid,
    )
    assert_true(received_hashes == [expected_hash], "10 MiB attachment changed in transit")
    print("NET: 10 MiB attachment round-trip passed", flush=True)

    tampered_mid = alice_page.evaluate("(recipient) => window.injectTamperedSignature(recipient)", bob)
    bob_page.wait_for_function(
        "(mid) => window.received.some(message => message.mid === mid && message.meta.verified === 'invalid')",
        arg=tampered_mid,
        timeout=45_000,
    )
    alice_page.wait_for_function("window.status === 'online'", timeout=45_000)
    print("NET: invalid signature delivered to receiver", flush=True)

    bob_page.evaluate("window.stopMailbox()")
    offline_mid = alice_page.evaluate("(recipient) => window.enqueueMail(recipient)", bob)
    alice_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'queued' && event.nextAttempt)",
        arg=offline_mid,
        timeout=40_000,
    )
    assert_true(
        alice_page.evaluate("window.status") == "online",
        "Offline-recipient error changed the sender transport status",
    )
    bob_page.evaluate("(handle) => window.setupMailbox(handle)", bob)
    bob_page.wait_for_function("window.status === 'online'", timeout=45_000)
    bob_page.wait_for_function(
        "(mid) => window.received.some(message => message.mid === mid)",
        arg=offline_mid,
        timeout=60_000,
    )
    alice_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'delivered')",
        arg=offline_mid,
        timeout=60_000,
    )
    assert_true(alice_page.evaluate("window.retryNowCalls") == 0, "Offline delivery required explicit retryNow")
    print("NET: offline retry succeeded through the scheduler", flush=True)

    alice_page.evaluate("window.stopMailbox()")
    bob_to_alice_mid = bob_page.evaluate("(recipient) => window.enqueueMail(recipient)", alice)
    bob_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'queued')",
        arg=bob_to_alice_mid,
        timeout=40_000,
    )
    bob_page.evaluate("(mid) => window.deferOutboxItem(mid, 60_000)", bob_to_alice_mid)
    alice_page.evaluate("(handle) => window.setupMailbox(handle)", alice)
    alice_page.wait_for_function("window.status === 'online'", timeout=45_000)
    alice_page.evaluate("(recipient) => window.enqueueMail(recipient)", bob)
    alice_page.wait_for_function(
        "(mid) => window.received.some(message => message.mid === mid)",
        arg=bob_to_alice_mid,
        timeout=45_000,
    )
    bob_page.wait_for_function(
        "(mid) => window.outboxItems().then(items => !items.some(item => item.mid === mid))",
        arg=bob_to_alice_mid,
        timeout=30_000,
    )
    print("NET: incoming-connection outbox flush passed", flush=True)

    reload_mid = alice_page.evaluate("(recipient) => window.enqueueMail(recipient)", unavailable)
    alice_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'queued')",
        arg=reload_mid,
        timeout=40_000,
    )
    alice_page.reload()
    alice_page.wait_for_function("window.harnessReady === true")
    alice_page.evaluate("(handle) => window.setupMailbox(handle)", alice)
    alice_page.wait_for_function("window.status === 'online'", timeout=60_000)

    target_context = browser.new_context()
    target_page = target_context.new_page()
    target_page.goto(f"{base_url}/tests/net-harness.html")
    target_page.wait_for_function("window.harnessReady === true")
    target_page.evaluate("(handle) => window.setupMailbox(handle)", unavailable)
    target_page.wait_for_function("window.status === 'online'", timeout=45_000)
    target_page.wait_for_function(
        "(mid) => window.received.some(message => message.mid === mid)",
        arg=reload_mid,
        timeout=60_000,
    )
    print("NET: queued item survived reload and was delivered", flush=True)
    alice_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'delivered')",
        arg=reload_mid,
        timeout=60_000,
    )

    cancel_recipient = random_handle("c")
    cancelled_mid = alice_page.evaluate(
        "(recipient) => window.enqueueMail(recipient)",
        cancel_recipient,
    )
    alice_page.wait_for_function(
        "(mid) => window.deliveries.some(event => event.mid === mid && event.state === 'queued')",
        arg=cancelled_mid,
        timeout=40_000,
    )
    alice_page.evaluate("(mid) => window.cancelMail(mid)", cancelled_mid)
    assert_true(
        alice_page.evaluate("window.outboxItems().then(items => items.length === 0)"),
        "Cancellation did not empty the outbox",
    )
    delivery_count = alice_page.evaluate(
        "(mid) => window.deliveries.filter(event => event.mid === mid).length",
        cancelled_mid,
    )

    cancel_context = browser.new_context()
    cancel_page = cancel_context.new_page()
    cancel_page.goto(f"{base_url}/tests/net-harness.html")
    cancel_page.wait_for_function("window.harnessReady === true")
    cancel_page.evaluate("(handle) => window.setupMailbox(handle)", cancel_recipient)
    cancel_page.wait_for_function("window.status === 'online'", timeout=45_000)
    cancel_page.wait_for_timeout(20_000)
    assert_true(
        cancel_page.evaluate("(mid) => window.received.some(message => message.mid === mid)", cancelled_mid)
        is False,
        "Cancelled item was delivered after the recipient came online",
    )
    assert_true(
        alice_page.evaluate(
            "(mid) => window.deliveries.filter(event => event.mid === mid).length",
            cancelled_mid,
        ) == delivery_count,
        "Transport reported a delivery after cancellation",
    )
    print("NET: cancellation removed the offline item and suppressed later delivery", flush=True)

    assert_true(taken == "taken" and available == "available", "Availability checks were inconsistent")
    print(
        "PASS net: PeerJS delivery/ack/TOFU, 10 MiB attachment, invalid signature, "
        "offline scheduler, incoming flush, availability, reload persistence and cancellation"
    )

    cancel_context.close()
    target_context.close()
    alice_context.close()
    bob_context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--only",
        help="comma-separated test groups (crypto,htmlpreview,net); defaults to all",
    )
    options = parser.parse_args()
    selected = set(options.only.split(",")) if options.only else None
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        wait_until_ready(f"{base_url}/tests/", server)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=CHROME,
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-background-timer-throttling",
                    "--disable-renderer-backgrounding",
                    "--disable-backgrounding-occluded-windows",
                ],
            )
            failures = []
            for name, test in (
                ("crypto", test_crypto),
                ("htmlpreview", test_htmlpreview),
                ("net", test_net),
            ):
                if selected and name not in selected:
                    continue
                try:
                    test(browser, base_url)
                except Exception as error:
                    failures.append((name, error))
                    print(f"FAIL {name}: {type(error).__name__}: {error}")
            browser.close()
        if failures:
            raise SystemExit(1)
        print("ALL TESTS PASSED")
    finally:
        server.terminate()
        server.wait(timeout=5)


if __name__ == "__main__":
    main()
