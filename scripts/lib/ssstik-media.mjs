/**
 * Shared SSSTik media-link rules for the offline CLI probe.
 *
 * This mirrors `src/providers/download/ssstik-media.ts` (the Worker-side
 * implementation) so `npm run probe:ssstik` and the deployed provider cannot
 * drift apart. It is plain ESM with no dependencies, because the probe runs
 * under `node --test` without a build step.
 *
 * Why unwrapping is needed at all: SSSTik's CDN hosts frequently carry the real,
 * signed TikTok CDN URL base64-encoded into the *path* instead of redirecting to
 * it. `/` is part of the base64 alphabet, so a long payload is split across
 * several path segments and has to be rejoined before it can be decoded.
 */

/** Hosts whose path may embed a base64-encoded target URL. */
export const WRAPPER_HOSTS = ['ssscdn.io', 'tikcdn.io', 'ssstik.io'];

/**
 * Hosts a media URL may live on: SSSTik's own wrappers plus the TikTok /
 * ByteDance CDNs they point at. Signed TikTok URLs are regional, so the regional
 * CDN hostnames have to be listed or a valid decode is rejected for some series.
 */
export const MEDIA_HOSTS = [
  'ssstik.io',
  'ssscdn.io',
  'tikcdn.io',
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'tiktokcdnv.com',
  'bytecdn.com',
  'byteicdn.com',
  'bytefcdn.net',
  'byteoversea.com',
  'ibytedtos.com',
  'ibyteimg.com',
  'muscdn.com',
  'mzstatic.com',
];

/**
 * Strict base64 only. `atob` and `Buffer.from(…, 'base64')` both silently ignore
 * invalid characters, which would truncate a payload instead of rejecting it.
 */
const BASE64_SEGMENT = /^[A-Za-z0-9+/]+={0,2}$/;

/** Shortest segment worth decoding (`https://t.co/1` is already 20 characters). */
const MIN_DECODE_SEGMENT = 20;

/**
 * Decode one base64 segment into an HTTPS URL, or `null` when it is not base64,
 * not UTF-8 text, or not an HTTPS URL.
 *
 * Returns `null` rather than throwing: an SSSTik link may be an opaque proxy URL
 * that has to be *fetched* instead of decoded, and the caller cannot know which
 * without trying.
 */
export function decodeBase64UrlSegment(segment) {
  const candidate = String(segment).trim();
  if (candidate.length < MIN_DECODE_SEGMENT || !BASE64_SEGMENT.test(candidate)) return null;

  let bytes;
  try {
    // `atob`, not `Buffer.from(…, 'base64')`: Node's Buffer silently ignores
    // invalid characters and malformed padding, whereas `atob` throws. The Worker
    // implementation only has `atob`, so using it here keeps the two byte-identical
    // in what they accept.
    const binary = atob(candidate);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null; // binary segment (a thumbnail hash, an id), not a URL
  }
  if (/[\u0000-\u0020\u007f]/.test(text)) return null;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  return parsed.href;
}

/**
 * Unwrap an SSSTik result link.
 *
 *   https://ssscdn.io/en/ssstik/<base64>  ->  the decoded target
 *   https://tikcdn.io/ssstik/a/<base64>   ->  the decoded target
 *   https://ssscdn.io/dl/abc123           ->  unchanged (fetch it, follow redirects)
 *
 * Candidate spans are tried longest-first, so the intended reading (a
 * `/en/ssstik/` prefix plus the payload) wins over a coincidental decode of a
 * shorter tail.
 *
 * The decoded URL is returned *unvalidated* on purpose: the caller must run it
 * through the host allow-list and its SSRF guard exactly as it would any other
 * URL, because a decoded payload never appeared in a response header.
 */
export function unwrapMediaUrl(href) {
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    throw new Error('SSSTik returned an invalid media URL.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const isWrapper = WRAPPER_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!isWrapper) return { url: parsed.href, decoded: false };

  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  for (let span = Math.max(0, segments.length - 1); span >= 0; span -= 1) {
    const candidate = segments.slice(span).map((segment) => decodeURIComponent(segment)).join('/');
    const decoded = decodeBase64UrlSegment(candidate);
    if (decoded) return { url: decoded, decoded: true };
  }
  return { url: parsed.href, decoded: false };
}

export function isAllowedMediaHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  return MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
