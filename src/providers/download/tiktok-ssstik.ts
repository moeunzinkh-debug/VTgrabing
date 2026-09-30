import { badRequest, notConfigured } from '../../core/errors';
import type { Env } from '../../env';
import { baseHeaders, flag, grabConfig } from '../../grab/config';
import { safeUrl } from '../../grab/guard';
import { Budget, readTextLimited } from '../../grab/net';
import { isTikTokHost } from '../../grab/tiktok';
import type { ProviderDescriptor } from '../../shared/types';
import type { DownloadProvider, DownloadRequest, DownloadResult } from './types';

/**
 * Optional, unofficial single-post adapter for the public SSSTik web form.
 * It is deliberately not the default provider. Enabling it sends a TikTok URL to
 * SSSTik, uses no TikTok account/session, and stops on challenges or format changes.
 */
const SSSTIK_ORIGIN = 'https://ssstik.io';
const SSSTIK_HOME = `${SSSTIK_ORIGIN}/`;
const SSSTIK_FORM = `${SSSTIK_ORIGIN}/abc?url=dl`;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const MEDIA_HOSTS = [
  'ssstik.io',
  'ssscdn.io',
  'tiktok.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'bytecdn.com',
  'muscdn.com',
  'ibytedtos.com',
  'byteoversea.com',
];

type ResultLink = { kind: 'video' | 'audio'; url: string };

function enabled(env: Env): boolean {
  return flag(env.TIKTOK_SSTIK_ENABLED, false);
}

function validatePostUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('SSSTik accepts one public TikTok video URL at a time. Analyze a TikTok share link first.');
  }
  const host = url.hostname.toLowerCase();
  const validPath = /^\/@[^/]+\/video\/\d{6,25}(?:\/|$)/.test(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !isTikTokHost(host) ||
    !validPath
  ) {
    throw badRequest('SSSTik only accepts a public HTTPS TikTok video post URL (not a profile, playlist, or short link).');
  }
  // Tracking data is not required to identify the post and should not be shared.
  url.search = '';
  url.hash = '';
  return url.href;
}

function extractPageToken(html: string): string | null {
  const match = /(?:\bs_tt\s*=\s*|\btt\s*:\s*)['"]([\w-]{4,128})['"]/.exec(html);
  return match?.[1] ?? null;
}

function decodeEntities(text: string): string {
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

function tagAttributes(tag: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    found[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return found;
}

function allowedMediaUrl(raw: string, cfg: ReturnType<typeof grabConfig>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('SSSTik returned an invalid media URL.');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  ) {
    throw badRequest(`SSSTik returned a media host outside VTGrab's safety allow-list: ${host}`);
  }
  return safeUrl(url, cfg).url;
}

/** Only explicit download buttons are considered; profile/ad links are ignored. */
function parseResultLinks(html: string, cfg: ReturnType<typeof grabConfig>): ResultLink[] {
  const results: ResultLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]{0,4096})>/gi)) {
    const attrs = tagAttributes(match[1]);
    const classes = (attrs.class ?? '').split(/\s+/);
    const kind = classes.includes('without_watermark') ? 'video' : classes.includes('music') ? 'audio' : null;
    if (!kind || !attrs.href) continue;
    let target: URL;
    try {
      target = new URL(attrs.href, SSSTIK_ORIGIN);
    } catch {
      continue;
    }
    try {
      target = allowedMediaUrl(target.href, cfg);
    } catch {
      continue;
    }
    if (seen.has(`${kind}:${target.href}`)) continue;
    seen.add(`${kind}:${target.href}`);
    results.push({ kind, url: target.href });
  }
  return results;
}

function cookieHeader(headers: Headers): string {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const entries = withGetSetCookie.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  return entries
    .map((entry) => /^([\w-]+=[^;,]*)/.exec(entry)?.[1])
    .filter((cookie): cookie is string => Boolean(cookie))
    .join('; ');
}

async function fetchNoRedirect(
  rawUrl: string,
  cfg: ReturnType<typeof grabConfig>,
  budget: Budget,
  init: RequestInit,
): Promise<Response> {
  const url = safeUrl(rawUrl, cfg).url;
  budget.take();
  const timeoutMs = Math.min(cfg.pageTimeoutMs, 20_000);
  try {
    const response = await fetch(url.toString(), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      cf: { cacheTtl: 0 },
    } as RequestInit);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw badRequest('SSSTik redirected the form request; stopping instead of following an unexpected target.');
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw badRequest(`SSSTik returned HTTP ${response.status} (challenge, access denial, or service error).`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error;
    throw badRequest(`Could not reach SSSTik: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readSsstikHtml(response: Response, finalUrl: URL): Promise<string> {
  const type = response.headers.get('content-type') ?? '';
  if (type && !/^(?:text\/html|text\/plain)(?:\s*;|\s*$)/i.test(type)) {
    await response.body?.cancel().catch(() => undefined);
    throw badRequest(`SSSTik returned unexpected content type "${type.slice(0, 100)}".`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_HTML_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw badRequest('SSSTik response exceeded the 1 MiB HTML limit.');
  }
  const result = await readTextLimited(response, MAX_HTML_BYTES, finalUrl);
  if (result.truncated) throw badRequest('SSSTik response exceeded the 1 MiB HTML limit.');
  return result.text;
}

async function fetchMedia(
  rawUrl: string,
  cfg: ReturnType<typeof grabConfig>,
  budget: Budget,
): Promise<Response> {
  let url = allowedMediaUrl(rawUrl, cfg);
  for (let hop = 0; hop <= Math.min(cfg.maxRedirects, 5); hop += 1) {
    budget.take();
    const timeoutMs = cfg.mediaTimeoutMs;
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          ...baseHeaders(cfg, SSSTIK_HOME),
          accept: 'video/mp4,application/octet-stream;q=0.9',
        },
        cf: { cacheTtl: 0 },
      } as RequestInit);
    } catch (error) {
      throw badRequest(`Could not fetch the SSSTik media response: ${error instanceof Error ? error.message : String(error)}`);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      if (!location || hop === Math.min(cfg.maxRedirects, 5)) {
        throw badRequest('SSSTik media redirected too many times or without a Location header.');
      }
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        throw badRequest('SSSTik media returned an invalid redirect target.');
      }
      url = allowedMediaUrl(target.href, cfg);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw badRequest(`SSSTik media host returned HTTP ${response.status}.`);
    }
    return response;
  }
  throw badRequest('Too many SSSTik media redirects.');
}

interface VerifiedMp4 {
  stream: ReadableStream<Uint8Array>;
  contentLength?: number;
}

/** Read just enough to verify the ISO-BMFF ftyp signature, then pass bytes through. */
async function verifiedMp4Stream(
  body: ReadableStream<Uint8Array> | null,
  contentLength: number | null,
  maxBytes: number,
  onProgress?: DownloadRequest['onProgress'],
): Promise<VerifiedMp4> {
  if (!body) throw badRequest('SSSTik media response had no body.');
  const reader = body.getReader();
  const initialChunks: Uint8Array[] = [];
  let initialBytes = 0;
  const head = new Uint8Array(8);
  let headBytes = 0;

  try {
    while (headBytes < 8) {
      const { done, value } = await reader.read();
      if (done || !value?.byteLength) throw badRequest('SSSTik media response is too short to be an MP4 file.');
      if (initialBytes + value.byteLength > maxBytes) throw badRequest(`SSSTik media exceeded ${maxBytes} bytes.`);
      initialChunks.push(value);
      initialBytes += value.byteLength;
      const take = Math.min(value.byteLength, 8 - headBytes);
      head.set(value.subarray(0, take), headBytes);
      headBytes += take;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof Error && 'status' in error) throw error;
    throw error;
  }

  // ISO Base Media File Format (MP4) starts with a box size and the "ftyp" brand.
  if (String.fromCharCode(...head.subarray(4, 8)) !== 'ftyp') {
    await reader.cancel().catch(() => undefined);
    throw badRequest('SSSTik response is not an MP4 file (invalid ftyp signature).');
  }

  let bytesRead = initialBytes;
  let bytesSent = 0;
  const progress = async (size: number): Promise<void> => {
    bytesSent += size;
    await onProgress?.({
      bytes: bytesSent,
      totalBytes: contentLength,
      percent: contentLength ? Math.min(99, Math.floor((bytesSent / contentLength) * 100)) : undefined,
    });
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (initialChunks.length > 0) {
          const chunk = initialChunks.shift()!;
          await progress(chunk.byteLength);
          controller.enqueue(chunk);
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          if (contentLength !== null && bytesRead !== contentLength) {
            controller.error(badRequest('SSSTik media ended before its advertised Content-Length.'));
            return;
          }
          await reader.cancel().catch(() => undefined);
          await onProgress?.({ bytes: bytesSent, totalBytes: contentLength, percent: 100 });
          controller.close();
          return;
        }
        if (!value?.byteLength) return;
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          controller.error(badRequest(`SSSTik media exceeded ${maxBytes} bytes.`));
          await reader.cancel().catch(() => undefined);
          return;
        }
        await progress(value.byteLength);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await reader.cancel().catch(() => undefined);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return { stream, contentLength: contentLength ?? undefined };
}

export class TikTokSsstikDownloadProvider implements DownloadProvider {
  readonly key = 'tiktok-ssstik';
  readonly label = 'TikTok via SSSTik (unofficial third party; opt-in)';
  readonly kind = 'http' as const;

  isConfigured(env: Env): boolean {
    return enabled(env);
  }

  describe(env: Env): ProviderDescriptor {
    const available = enabled(env);
    return {
      key: this.key,
      label: this.label,
      kind: this.kind,
      available,
      configured: available,
      reason: available
        ? 'Unofficial and unstable. Sends one public TikTok post URL to SSSTik, then streams one verified MP4 into R2. No TikTok login, captcha solving, or DRM bypass.'
        : 'Off by default. Explicitly opt in with TIKTOK_SSTIK_ENABLED=true; confirm rights and third-party URL sharing for every job.',
      docs: 'README.md#tiktok-link-analysis',
    };
  }

  async start(request: DownloadRequest, env: Env): Promise<DownloadResult> {
    if (!enabled(env)) throw notConfigured('TikTok via SSSTik is off. Set TIKTOK_SSTIK_ENABLED=true to opt in.');
    const videoUrl = validatePostUrl(request.sourceUrl);
    const cfg = grabConfig(env);
    const budget = new Budget(Math.min(cfg.maxSubrequests, 24));
    const homeUrl = safeUrl(SSSTIK_HOME, cfg).url;
    const homeResponse = await fetchNoRedirect(
      homeUrl.href,
      cfg,
      budget,
      { method: 'GET', headers: baseHeaders(cfg, SSSTIK_HOME) },
    );
    const cookie = cookieHeader(homeResponse.headers);
    const token = extractPageToken(await readSsstikHtml(homeResponse, homeUrl));
    if (!token) {
      throw badRequest('No public SSSTik form token found; its page may have changed or shown a bot challenge.');
    }

    const postResponse = await fetchNoRedirect(
      SSSTIK_FORM,
      cfg,
      budget,
      {
        method: 'POST',
        headers: {
          ...baseHeaders(cfg, SSSTIK_HOME),
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'text/html',
          origin: SSSTIK_ORIGIN,
          referer: SSSTIK_HOME,
          'hx-request': 'true',
          ...(cookie ? { cookie } : {}),
        },
        body: new URLSearchParams({ id: videoUrl, locale: 'en', tt: token }).toString(),
      },
    );
    const links = parseResultLinks(await readSsstikHtml(postResponse, new URL(SSSTIK_FORM)), cfg);
    const video = links.find((entry) => entry.kind === 'video');
    if (!video) {
      throw badRequest('SSSTik returned no MP4 link for this post (unavailable, challenged, or response format changed).');
    }

    const media = await fetchMedia(video.url, cfg, budget);
    const contentType = (media.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType && contentType !== 'video/mp4' && contentType !== 'application/octet-stream') {
      await media.body?.cancel().catch(() => undefined);
      throw badRequest(`Refusing non-MP4 SSSTik response (${contentType}).`);
    }
    const lengthHeader = media.headers.get('content-length');
    const parsedLength = lengthHeader === null ? null : Number(lengthHeader);
    if (
      parsedLength !== null &&
      (!Number.isSafeInteger(parsedLength) || parsedLength < 8 || parsedLength > Math.min(MAX_VIDEO_BYTES, cfg.maxVideoBytes))
    ) {
      await media.body?.cancel().catch(() => undefined);
      throw badRequest('SSSTik returned an invalid or oversized media Content-Length.');
    }

    const verified = await verifiedMp4Stream(
      media.body,
      parsedLength,
      Math.min(MAX_VIDEO_BYTES, cfg.maxVideoBytes),
      request.onProgress,
    );
    return {
      kind: 'stream',
      stream: verified.stream,
      contentLength: verified.contentLength,
      contentType: 'video/mp4',
      container: 'mp4',
      quality: request.quality,
    };
  }
}
