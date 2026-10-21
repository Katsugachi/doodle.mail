import { fingerprint, signEnvelope, verifyEnvelope } from './crypto.js';

export const PEER_PREFIX = 'doodlemail-v1-';
export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];
const ACK_TIMEOUT = 12_000;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const BACKOFF = [5_000, 15_000, 30_000, 60_000];

export function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase().replace(/@doodle\.mail$/i, '');
  return HANDLE_RE.test(normalized) ? normalized : null;
}

function peerOptions(config) {
  const options = {
    config: { iceServers: config?.iceServers || DEFAULT_ICE_SERVERS },
  };
  for (const key of ['host', 'port', 'path', 'secure']) {
    if (config?.[key] !== undefined) options[key] = config[key];
  }
  return options;
}

function peerConstructor() {
  const Peer = globalThis.peerjs?.Peer;
  if (typeof Peer !== 'function') throw new Error('PeerJS is not loaded');
  return Peer;
}

export async function checkAvailability(address, config) {
  const handle = normalizeAddress(address);
  if (!handle) return 'error';

  return new Promise(resolve => {
    let peer;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        if (peer && !peer.destroyed) peer.destroy();
      } catch {
        // The probe is best-effort cleanup.
      }
      resolve(result);
    };

    const timeout = setTimeout(() => finish('error'), 10_000);
    try {
      const Peer = peerConstructor();
      peer = new Peer(`${PEER_PREFIX}${handle}`, peerOptions(config));
      peer.on('open', () => finish('available'));
      peer.on('error', error => finish(error?.type === 'unavailable-id' ? 'taken' : 'error'));
    } catch {
      finish('error');
    }
  });
}

function getRecipient(peerId) {
  if (typeof peerId !== 'string' || !peerId.startsWith(PEER_PREFIX)) return null;
  const address = peerId.slice(PEER_PREFIX.length);
  return HANDLE_RE.test(address) ? address : null;
}

function validString(value, maxLength = Infinity) {
  return typeof value === 'string' && value.length <= maxLength;
}

function normalizeAttachmentBuffers(envelope) {
  if (!envelope || typeof envelope !== 'object' || !Array.isArray(envelope.attachments)) {
    return envelope;
  }
  return {
    ...envelope,
    attachments: envelope.attachments.map(attachment => {
      if (!attachment || typeof attachment !== 'object' || !ArrayBuffer.isView(attachment.data)) {
        return attachment;
      }
      const data = attachment.data;
      return {
        ...attachment,
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      };
    }),
  };
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return 'invalid-envelope';
  if (envelope.v !== 1 || envelope.type !== 'mail') return 'invalid-envelope';
  if (!validString(envelope.mid, 200) || !envelope.mid) return 'invalid-mid';
  if (!validString(envelope.threadId, 200) || !envelope.threadId) return 'invalid-thread';
  if (envelope.inReplyTo !== null && envelope.inReplyTo !== undefined
    && !validString(envelope.inReplyTo, 200)) return 'invalid-reply';
  if (!envelope.from || typeof envelope.from !== 'object'
    || !validString(envelope.from.address, 24)
    || !HANDLE_RE.test(envelope.from.address)
    || !validString(envelope.from.name, 200)) return 'invalid-sender';
  if (!Array.isArray(envelope.to) || !Array.isArray(envelope.cc)
    || (envelope.bcc !== undefined && !Array.isArray(envelope.bcc))) {
    return 'invalid-recipients';
  }
  const recipients = [...envelope.to, ...envelope.cc, ...(envelope.bcc || [])];
  if (recipients.length > 50 || !recipients.every(value => validString(value, 255))) {
    return 'invalid-recipients';
  }
  if (!validString(envelope.subject, 500) || !validString(envelope.text, 200_000)
    || !validString(envelope.date, 100)) return 'invalid-content';
  if (!Array.isArray(envelope.attachments) || envelope.attachments.length > 20) {
    return 'invalid-attachments';
  }

  let attachmentBytes = 0;
  for (const attachment of envelope.attachments) {
    if (!attachment || typeof attachment !== 'object'
      || !validString(attachment.id, 500)
      || !validString(attachment.name, 500)
      || !validString(attachment.type, 255)
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 0
      || !(attachment.data instanceof ArrayBuffer)) {
      return 'invalid-attachment';
    }
    if (attachment.data.byteLength !== attachment.size) return 'invalid-attachment-size';
    attachmentBytes += attachment.data.byteLength;
  }

  const metadata = {
    ...envelope,
    attachments: envelope.attachments.map(({ data, ...attachment }) => attachment),
  };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
  if (attachmentBytes + metadataBytes > MAX_MESSAGE_BYTES) return 'message-too-large';
  return null;
}

export function createTransport({
  address,
  name,
  identity,
  config,
  outbox,
  getBlob,
  knownKeys,
  onStatus,
  onMessage,
  onDelivery,
}) {
  const peerId = `${PEER_PREFIX}${address}`;
  let peer = null;
  let currentStatus = 'offline';
  let started = false;
  let halted = false;
  let schedulerTimer = null;
  let reconnectTimer = null;
  let reconnectDelay = 1_000;
  let scheduling = false;
  const busy = new Map();
  const queuedItems = new Map();
  const cancelledIds = new Set();
  const openConnections = new Map();
  const ackWaiters = new Map();
  const attachedConnections = new WeakSet();

  function setStatus(status, detail) {
    currentStatus = status;
    try {
      onStatus?.(status, detail);
    } catch {
      // User callbacks must not disrupt transport state.
    }
  }

  function reportDelivery(item, state, info = {}) {
    if (cancelledIds.has(item.id)) return;
    try {
      onDelivery?.(item, state, info);
    } catch {
      // User callbacks must not disrupt delivery.
    }
  }

  function addConnection(conn) {
    let connections = openConnections.get(conn.peer);
    if (!connections) {
      connections = new Set();
      openConnections.set(conn.peer, connections);
    }
    connections.add(conn);
  }

  function removeConnection(conn) {
    const connections = openConnections.get(conn.peer);
    if (!connections) return;
    connections.delete(conn);
    if (!connections.size) openConnections.delete(conn.peer);
  }

  function sendNack(conn, mid, reason) {
    try {
      conn.send({ kind: 'nack', mid, reason: String(reason).slice(0, 200) });
    } catch {
      // The sender will retry if the connection cannot carry the nack.
    }
  }

  async function receiveMail(conn, packet) {
    const envelope = normalizeAttachmentBuffers(packet.envelope);
    const invalidReason = validateEnvelope(envelope);
    if (invalidReason) {
      sendNack(conn, envelope?.mid, invalidReason);
      return;
    }

    let verified = false;
    try {
      verified = await verifyEnvelope(packet.pub, envelope, packet.sig);
    } catch {
      verified = false;
    }

    let meta = 'invalid';
    let senderFingerprint;
    try {
      senderFingerprint = await fingerprint(packet.pub);
    } catch {
      // Invalid public keys still reach the app as unverified mail.
    }

    if (verified && conn.peer === `${PEER_PREFIX}${envelope.from.address}`) {
      try {
        const pinnedKey = await knownKeys?.get(envelope.from.address);
        if (!pinnedKey) {
          await knownKeys?.set(envelope.from.address, packet.pub);
          meta = 'new';
        } else if (await fingerprint(pinnedKey) === senderFingerprint) {
          meta = 'ok';
        } else {
          meta = 'mismatch';
        }
      } catch {
        meta = 'invalid';
      }
    }

    try {
      await onMessage?.(envelope, {
        verified: meta,
        fingerprint: senderFingerprint,
      });
      conn.send({ kind: 'ack', mid: envelope.mid });
    } catch (error) {
      sendNack(conn, envelope.mid, error?.message || 'message-rejected');
    }
  }

  function handleConnectionData(conn, packet) {
    if (!packet || typeof packet !== 'object') return;
    if (packet.kind === 'ack' || packet.kind === 'nack') {
      const waiters = ackWaiters.get(packet.mid);
      const waiter = waiters?.get(conn);
      if (!waiter) return;
      waiters.delete(conn);
      if (!waiters.size) ackWaiters.delete(packet.mid);
      if (packet.kind === 'ack') waiter.resolve(packet);
      else {
        const error = new Error(packet.reason || 'Remote rejected the message');
        error.nack = true;
        waiter.reject(error);
      }
      return;
    }
    if (packet.kind === 'mail') void receiveMail(conn, packet);
  }

  function attachConnection(conn, incoming = false) {
    if (attachedConnections.has(conn)) return;
    attachedConnections.add(conn);

    const onOpen = () => {
      addConnection(conn);
      if (incoming) {
        const recipient = getRecipient(conn.peer);
        if (recipient) void flushRecipient(recipient, true);
      }
    };
    conn.on('data', packet => handleConnectionData(conn, packet));
    conn.on('open', onOpen);
    conn.on('close', () => {
      removeConnection(conn);
      const active = busy.get(getRecipient(conn.peer));
      if (active?.conn === conn && !active.finished) active.fail(new Error('Connection closed'));
    });
    conn.on('error', error => {
      const active = busy.get(getRecipient(conn.peer));
      if (active?.conn === conn && !active.finished) active.fail(error);
    });
    if (conn.open) onOpen();
  }

  function rejectPendingForPeer(error) {
    if (error?.type !== 'peer-unavailable') return;
    const message = String(error.message || '');
    for (const active of busy.values()) {
      if (message.includes(active.peerId)) active.fail(error);
    }
  }

  function clearReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(recreate = false) {
    if (!started || halted || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!started || halted) return;
      if (recreate || !peer || peer.destroyed) {
        createPeer();
        return;
      }
      try {
        peer.reconnect();
      } catch {
        createPeer();
      }
    }, delay);
  }

  function createPeer() {
    if (!started || halted) return;
    const previousPeer = peer;
    peer = null;
    if (previousPeer && !previousPeer.destroyed) {
      try {
        previousPeer.destroy();
      } catch {
        // A failed old connection should not block recreation.
      }
    }

    let nextPeer;
    try {
      const Peer = peerConstructor();
      nextPeer = new Peer(peerId, peerOptions(config));
    } catch (error) {
      setStatus('error', error);
      scheduleReconnect(true);
      return;
    }
    peer = nextPeer;
    setStatus('connecting');

    nextPeer.on('open', () => {
      if (peer !== nextPeer || !started || halted) return;
      clearReconnect();
      reconnectDelay = 1_000;
      setStatus('online');
      if (!schedulerTimer) schedulerTimer = setInterval(() => void runScheduler(false), 5_000);
      void runScheduler(true);
    });
    nextPeer.on('connection', conn => {
      attachConnection(conn, true);
    });
    nextPeer.on('disconnected', () => {
      if (peer !== nextPeer || !started || halted) return;
      setStatus('offline');
      scheduleReconnect(false);
    });
    nextPeer.on('close', () => {
      if (peer !== nextPeer || !started || halted) return;
      setStatus('offline');
      scheduleReconnect(true);
    });
    nextPeer.on('error', error => {
      if (peer !== nextPeer || !started || halted) return;
      if (error?.type === 'unavailable-id') {
        halted = true;
        clearReconnect();
        clearInterval(schedulerTimer);
        schedulerTimer = null;
        setStatus('taken', error);
        try {
          nextPeer.destroy();
        } catch {
          // The peer has already failed.
        }
        return;
      }
      rejectPendingForPeer(error);
      // Per-recipient failures (e.g. 'peer-unavailable') don't mean our own signalling link is down.
      if (!nextPeer.destroyed && !nextPeer.disconnected && nextPeer.open) return;
      setStatus('error', error);
      if (nextPeer.destroyed) scheduleReconnect(true);
    });
  }

  function ensureScheduler() {
    if (started && !halted && !schedulerTimer) {
      schedulerTimer = setInterval(() => void runScheduler(false), 5_000);
    }
  }

  async function persistFailure(item, error, state) {
    if (cancelledIds.has(item.id)) return item;
    const attempts = (Number(item.attempts) || 0) + 1;
    const backoffIndex = Math.min(attempts - 1, BACKOFF.length - 1);
    const delay = attempts <= BACKOFF.length ? BACKOFF[backoffIndex] : 120_000;
    const updated = {
      ...item,
      attempts,
      nextAttempt: Date.now() + Math.min(delay, 300_000),
      lastError: String(error?.message || error || 'delivery-failed'),
    };
    await outbox.put(updated);
    if (cancelledIds.has(item.id)) {
      queuedItems.delete(item.id);
      await outbox.delete(item.id);
      return updated;
    }
    queuedItems.set(item.id, updated);
    reportDelivery(updated, state, {
      error: updated.lastError,
      nextAttempt: updated.nextAttempt,
    });
    return updated;
  }

  async function openConnection(recipient, active) {
    const existing = [...(openConnections.get(active.peerId) || [])].find(conn => conn.open);
    if (existing) {
      active.conn = existing;
      return { conn: existing, owned: false };
    }
    if (!peer || !peer.open) throw new Error('Signaling connection is offline');

    const conn = peer.connect(active.peerId, { serialization: 'binary', reliable: true });
    active.conn = conn;
    attachConnection(conn);

    const opening = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), ACK_TIMEOUT);
      conn.on('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      conn.on('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      conn.on('close', () => {
        clearTimeout(timeout);
        reject(new Error('Connection closed before opening'));
      });
    });
    await Promise.race([opening, active.failurePromise]);
    return { conn, owned: true };
  }

  async function sendAndWait(conn, active, item) {
    const envelope = {
      ...item.envelope,
      attachments: await Promise.all((item.envelope.attachments || []).map(async attachment => {
        const blob = await getBlob(attachment.id);
        if (!blob || typeof blob.arrayBuffer !== 'function') {
          throw new Error(`Attachment not found: ${attachment.id}`);
        }
        const { data: ignored, ...metadata } = attachment;
        return { ...metadata, data: await blob.arrayBuffer() };
      })),
    };
    const sig = await signEnvelope(identity.privateJwk, envelope);

    let resolveWaiter;
    let rejectWaiter;
    const response = new Promise((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    let waiters = ackWaiters.get(item.mid);
    if (!waiters) {
      waiters = new Map();
      ackWaiters.set(item.mid, waiters);
    }
    waiters.set(conn, { resolve: resolveWaiter, reject: rejectWaiter });

    const timeout = setTimeout(() => {
      waiters.delete(conn);
      if (!waiters.size) ackWaiters.delete(item.mid);
      rejectWaiter(new Error('Acknowledgement timeout'));
    }, ACK_TIMEOUT);
    try {
      conn.send({ kind: 'mail', envelope, sig, pub: identity.publicJwk });
      await Promise.race([response, active.failurePromise]);
    } finally {
      clearTimeout(timeout);
      waiters.delete(conn);
      if (!waiters.size) ackWaiters.delete(item.mid);
    }
  }

  async function flushRecipient(recipient, bypassBackoff = false) {
    if (!started || halted || busy.has(recipient)) return;

    let failActive;
    let resolveItemsReady;
    let resolveDone;
    const failurePromise = new Promise((resolve, reject) => {
      failActive = reject;
    });
    const itemsReady = new Promise(resolve => {
      resolveItemsReady = resolve;
    });
    const done = new Promise(resolve => {
      resolveDone = resolve;
    });
    failurePromise.catch(() => {});
    const active = {
      peerId: `${PEER_PREFIX}${recipient}`,
      conn: null,
      finished: false,
      itemIds: new Set(),
      itemsReady,
      done,
      failurePromise,
      fail(error) {
        if (!this.finished) failActive(error || new Error('Delivery failed'));
      },
    };
    busy.set(recipient, active);

    let ownedConnection = false;
    try {
      const items = (await outbox.all())
        .filter(item => item.recipient === recipient)
        .filter(item => bypassBackoff || !item.nextAttempt || item.nextAttempt <= Date.now())
        .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
      active.itemIds = new Set(items.map(item => item.id));
      resolveItemsReady();
      for (const item of items) {
        if (!cancelledIds.has(item.id)) queuedItems.set(item.id, item);
      }
      if (!items.length) return;

      const opened = await openConnection(recipient, active);
      const conn = opened.conn;
      ownedConnection = opened.owned;

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (cancelledIds.has(item.id)) continue;
        reportDelivery(item, 'sending');
        try {
          await sendAndWait(conn, active, item);
          if (cancelledIds.has(item.id)) {
            queuedItems.delete(item.id);
            continue;
          }
          await outbox.delete(item.id);
          queuedItems.delete(item.id);
          reportDelivery(item, 'delivered');
        } catch (error) {
          if (cancelledIds.has(item.id)) {
            queuedItems.delete(item.id);
            continue;
          }
          if (error?.nack) {
            await persistFailure(item, error, 'failed');
            continue;
          }
          await persistFailure(item, error, 'queued');
          for (const remaining of items.slice(index + 1)) {
            if (!cancelledIds.has(remaining.id)) {
              await persistFailure(remaining, error, 'queued');
            }
          }
          break;
        }
      }
    } catch (error) {
      const items = (await outbox.all())
        .filter(item => item.recipient === recipient)
        .filter(item => bypassBackoff || !item.nextAttempt || item.nextAttempt <= Date.now());
      for (const item of items) await persistFailure(item, error, 'queued');
    } finally {
      resolveItemsReady();
      active.finished = true;
      if (ownedConnection && active.conn) {
        try {
          active.conn.close();
        } catch {
          // The connection may already be closed.
        }
      }
      busy.delete(recipient);
      resolveDone();
    }
  }

  async function runScheduler(bypassBackoff) {
    if (!started || halted || scheduling) return;
    scheduling = true;
    try {
      const items = await outbox.all();
      const recipients = new Set(items
        .filter(item => bypassBackoff || !item.nextAttempt || item.nextAttempt <= Date.now())
        .map(item => item.recipient));
      await Promise.all([...recipients].map(recipient => flushRecipient(recipient, bypassBackoff)));
    } catch (error) {
      setStatus('error', error);
    } finally {
      scheduling = false;
    }
  }

  function retryNow() {
    return runScheduler(true);
  }

  function onBrowserOnline() {
    void retryNow();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') void retryNow();
  }

  async function start() {
    if (started && !halted) return;
    started = true;
    halted = false;
    setStatus('connecting');
    if (typeof window !== 'undefined') window.addEventListener('online', onBrowserOnline);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    ensureScheduler();
    try {
      const items = await outbox.all();
      for (const item of items) {
        if (!cancelledIds.has(item.id)) queuedItems.set(item.id, item);
      }
    } catch (error) {
      setStatus('error', error);
    }
    createPeer();
  }

  function stop() {
    started = false;
    halted = false;
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    clearReconnect();
    if (typeof window !== 'undefined') window.removeEventListener('online', onBrowserOnline);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    for (const active of busy.values()) active.fail(new Error('Transport stopped'));
    const oldPeer = peer;
    peer = null;
    if (oldPeer && !oldPeer.destroyed) {
      try {
        oldPeer.destroy();
      } catch {
        // PeerJS may already have destroyed the peer.
      }
    }
    for (const connections of openConnections.values()) {
      for (const conn of connections) {
        try {
          conn.close();
        } catch {
          // Connection cleanup is best-effort.
        }
      }
    }
    openConnections.clear();
    setStatus('offline');
  }

  async function enqueue(item) {
    await outbox.put(item);
    queuedItems.set(item.id, item);
    if (started && !halted) void flushRecipient(item.recipient, true);
    else reportDelivery(item, 'queued', { nextAttempt: item.nextAttempt });
  }

  async function cancel(itemId) {
    cancelledIds.add(itemId);
    queuedItems.delete(itemId);
    await outbox.delete(itemId);

    const attempts = [...busy.values()];
    const activeAttempts = [];
    for (const active of attempts) {
      await active.itemsReady;
      if (active.itemIds.has(itemId)) activeAttempts.push(active.done);
    }
    await Promise.all(activeAttempts);
    queuedItems.delete(itemId);
    cancelledIds.delete(itemId);
  }

  return {
    start,
    stop,
    enqueue,
    cancel,
    retryNow,
    get status() {
      return currentStatus;
    },
  };
}
