/**
 * HMAC-SHA256 helpers used to authenticate VTGrab <-> authorized download service
 * traffic. Every outbound request and every inbound callback carries
 * `X-VTGrab-Signature: sha256=<hex>` over a canonical, timestamped payload.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toHex(signature);
}

export async function signRequest(
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<{ 'x-vtgrab-timestamp': string; 'x-vtgrab-signature': string }> {
  const signature = await hmacHex(secret, `${timestampSeconds}.${body}`);
  return {
    'x-vtgrab-timestamp': String(timestampSeconds),
    'x-vtgrab-signature': `sha256=${signature}`,
  };
}

/** Constant-time string comparison (defeats trivial timing leaks). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function verifySignature(
  secret: string,
  payload: string,
  provided: string | null,
): Promise<boolean> {
  if (!provided) return false;
  const normalized = provided.startsWith('sha256=') ? provided.slice('sha256='.length) : provided;
  if (normalized.length === 0) return false;
  const expected = await hmacHex(secret, payload);
  return timingSafeEqual(normalized.toLowerCase(), expected.toLowerCase());
}

/** Canonical payload signed for provider callbacks: `<jobItemId>.<expiresAt>`. */
export function callbackPayload(jobItemId: string, expiresAt: number): string {
  return `${jobItemId}.${expiresAt}`;
}

/**
 * Absolute URL an external download service must PUT the finished media to.
 * `DOWNLOAD_CALLBACK_URL` takes precedence, otherwise the provided origin is used
 * (in production that is the Worker's own public URL).
 */
export function buildCallbackUrl(
  env: { DOWNLOAD_CALLBACK_URL?: string },
  origin: string,
  jobItemId: string,
  expiresAt: number,
): { url: string; payload: string } {
  const base = env.DOWNLOAD_CALLBACK_URL?.replace(/\/+$/, '') ?? origin.replace(/\/+$/, '');
  const url = new URL(`/api/internal/provider/callback/${jobItemId}`, base);
  url.searchParams.set('expires', String(expiresAt));
  return { url: url.toString(), payload: callbackPayload(jobItemId, expiresAt) };
}

/** Callback URL including the `sig` query parameter the provider must use. */
export async function signedCallbackUrl(
  env: { DOWNLOAD_CALLBACK_URL?: string },
  origin: string,
  jobItemId: string,
  expiresAt: number,
  secret: string,
): Promise<string> {
  const { url, payload } = buildCallbackUrl(env, origin, jobItemId, expiresAt);
  const signature = await hmacHex(secret, payload);
  const target = new URL(url);
  target.searchParams.set('sig', `sha256=${signature}`);
  return target.toString();
}
