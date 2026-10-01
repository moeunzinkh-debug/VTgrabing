#!/usr/bin/env node
/**
 * Experimental, opt-in probe of the public SSSTik form flow described by
 * third-party clients (2023–2024). NOT an official API or a production provider.
 * Normal mode does not download media. --download explicitly saves ONE verified
 * MP4 to ./downloads. Neither mode bypasses challenges or sends TikTok credentials.
 *
 * Usage: npm run probe:ssstik -- 'https://www.tiktok.com/@user/video/1234567890123456789'
 *        npm run download:ssstik -- 'https://www.tiktok.com/@user/video/1234567890123456789'
 */
import { pathToFileURL } from 'node:url';
import { unwrapMediaUrl } from './lib/ssstik-media.mjs';
import { downloadOneVideo } from './ssstik-download.mjs';

const ORIGIN = 'https://ssstik.io';
const MAX_HTML_BYTES = 1024 * 1024;

export function validateTikTokUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Supply a valid public TikTok video or short URL.');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) ||
    !(/^\/@[^/]+\/(?:video|photo)\/\d{6,25}(?:\/|$)/.test(url.pathname) ||
      (/^(?:vm|vt)\.tiktok\.com$/.test(host) && /^\/[\w-]+\/?$/.test(url.pathname)) ||
      /^\/(?:t|v)\/[\w-]+\/?$/.test(url.pathname))) {
    throw new Error('Only public HTTPS TikTok video/photo or TikTok short links are accepted.');
  }
  return url.href;
}

export function extractPageToken(html) {
  // These two spellings appear in historical, independent third-party clients.
  // A missing token is an honest stop (e.g. changed page or captcha), not a
  // reason to invent a token or solve a challenge.
  const match = /(?:\bs_tt\s*=\s*|\btt\s*:\s*)['"]([\w-]{4,128})['"]/.exec(html);
  return match?.[1] ?? null;
}

function decodeEntities(text) {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#(?:x[\da-f]+|\d+));/gi, (entity) => {
    const value = entity.slice(1, -1).toLowerCase();
    if (value === 'amp') return '&';
    if (value === 'quot') return '"';
    if (value === 'apos') return "'";
    if (value === 'lt') return '<';
    if (value === 'gt') return '>';
    const code = value.startsWith('#x') ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function attributes(tag) {
  const found = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    found[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return found;
}

/** Only return explicit download controls, not ad links or author/profile links. */
export function parseResults(html) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b([^>]{0,4096})>/gi)) {
    const attrs = attributes(match[1]);
    const classes = (attrs.class ?? '').split(/\s+/);
    const kind = classes.includes('without_watermark') ? 'video' : classes.includes('music') ? 'audio' : null;
    if (!kind || !attrs.href) continue;
    let target;
    try {
      // SSSTik's CDN hosts may base64-encode the real target into the path
      // instead of redirecting; print what the link actually points at.
      const absolute = new URL(attrs.href, ORIGIN).href;
      target = new URL(unwrapMediaUrl(absolute).url);
    } catch {
      continue;
    }
    // This tool only *prints* the returned link. Still reject local addresses,
    // credentials, non-HTTPS schemes and protocol-relative surprises.
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || target.username || target.password || target.port ||
      host === 'localhost' || /\.(?:local|internal|test|invalid)$/.test(host) ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) continue;
    if (seen.has(`${kind}:${target.href}`)) continue;
    seen.add(`${kind}:${target.href}`);
    results.push({ kind, url: target.href });
  }
  return results;
}

async function limitedHtml(response) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`SSSTik returned HTTP ${response.status} (access denied, challenge or service error).`);
  }
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('SSSTik redirected this request; probe stops rather than following a new target.');
  }
  const type = response.headers.get('content-type') ?? '';
  if (type && !/^(?:text\/html|text\/plain)(?:\s*;|\s*$)/i.test(type)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Unexpected response content type: ${type.slice(0, 100)}`);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_HTML_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('SSSTik response exceeded the 1 MiB HTML limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTML_BYTES) throw new Error('SSSTik response exceeded the 1 MiB HTML limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

/** Keep only first-party cookies for the single POST in this process (never persisted). */
function sessionCookies(headers) {
  const setCookies = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  return setCookies.map((entry) => /^([\w-]+)=([^;,]*)/.exec(entry)?.slice(1).join('=')).filter(Boolean).join('; ');
}

export async function probeSsstik(input, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const videoUrl = validateTikTokUrl(input); // validate BEFORE touching the network
  const signal = AbortSignal.timeout(timeoutMs);
  const page = await fetchImpl(`${ORIGIN}/`, { method: 'GET', redirect: 'manual', signal });
  if (page.status >= 300 && page.status < 400) {
    await page.body?.cancel().catch(() => undefined);
    throw new Error('SSSTik homepage redirected; probe stops here.');
  }
  const cookie = sessionCookies(page.headers);
  const token = extractPageToken(await limitedHtml(page));
  if (!token) throw new Error('No public SSSTik form token found; page may have changed or shown a bot challenge.');

  const response = await fetchImpl(`${ORIGIN}/abc?url=dl`, {
    method: 'POST',
    redirect: 'manual',
    signal,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'accept': 'text/html',
      'origin': ORIGIN,
      'referer': `${ORIGIN}/`,
      'hx-request': 'true',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ id: videoUrl, locale: 'en', tt: token }).toString(),
  });
  const results = parseResults(await limitedHtml(response));
  if (!results.length) throw new Error('SSSTik did not return video/audio links; video unavailable, challenge, or response format changed.');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const downloading = process.argv[2] === '--download';
  const args = downloading ? process.argv.slice(3) : process.argv.slice(2);
  if (args.length !== 1 || !args[0] || args[0].startsWith('--')) {
    console.error('Usage: npm run probe:ssstik -- <public TikTok video URL>');
    console.error('   or: npm run download:ssstik -- <public TikTok video URL>');
    process.exitCode = 2;
  } else {
    try {
      const result = await probeSsstik(args[0]);
      if (downloading) {
        const saved = await downloadOneVideo(result);
        console.log(`Saved one MP4 to ${saved.path} (${saved.bytes} bytes).`);
      } else {
        console.log(JSON.stringify(result, null, 2));
        console.error('Results are unverified third-party links; no media was downloaded.');
      }
    } catch (error) {
      const cause = error instanceof Error && error.cause && typeof error.cause === 'object' && 'code' in error.cause
        ? ` (${String(error.cause.code)})` : '';
      console.error(`SSSTik probe failed: ${error instanceof Error ? error.message : String(error)}${cause}`);
      process.exitCode = 1;
    }
  }
}
