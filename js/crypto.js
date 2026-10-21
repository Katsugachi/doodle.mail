function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(entry => (
      entry === undefined || typeof entry === 'function' || typeof entry === 'symbol'
        ? null
        : stableValue(entry)
    ));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') {
        result[key] = stableValue(entry);
      }
    }
    return result;
  }
  return value;
}

export function canonicalize(obj) {
  return JSON.stringify(stableValue(obj));
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function arrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  throw new TypeError('Attachment data must be an ArrayBuffer');
}

async function signedEnvelope(envelope) {
  const copy = {
    ...envelope,
    attachments: await Promise.all((envelope.attachments || []).map(async attachment => {
      if (!Object.prototype.hasOwnProperty.call(attachment, 'data')) return { ...attachment };
      const digest = await crypto.subtle.digest('SHA-256', arrayBuffer(attachment.data));
      return { ...attachment, data: { sha256: bytesToHex(new Uint8Array(digest)) } };
    })),
  };
  return copy;
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function generateIdentity() {
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keys.publicKey),
    crypto.subtle.exportKey('jwk', keys.privateKey),
  ]);
  return { publicJwk, privateJwk };
}

export async function signEnvelope(privateJwk, envelope) {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const bytes = new TextEncoder().encode(canonicalize(await signedEnvelope(envelope)));
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bytes,
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function verifyEnvelope(publicJwk, envelope, sig) {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const bytes = new TextEncoder().encode(canonicalize(await signedEnvelope(envelope)));
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      decodeBase64(sig),
      bytes,
    );
  } catch {
    return false;
  }
}

export async function fingerprint(publicJwk) {
  const jwk = {
    crv: publicJwk.crv,
    kty: publicJwk.kty,
    x: publicJwk.x,
    y: publicJwk.y,
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalize(jwk)),
  );
  const firstEightBytes = bytesToHex(new Uint8Array(digest).slice(0, 8)).toUpperCase();
  return firstEightBytes.match(/.{1,4}/g).join(' ');
}
