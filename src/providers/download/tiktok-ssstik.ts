import { badRequest, notConfigured } from '../../core/errors';
import type { Env } from '../../env';
import { num } from '../../env';
import { baseHeaders, flag, grabConfig } from '../../grab/config';
import { safeUrl } from '../../grab/guard';
import { Budget, readTextLimited } from '../../grab/net';
import { isShortTikTokUrl, isTikTokHost, parseTikTokUrl } from '../../grab/tiktok';
import type { ProviderDescriptor } from '../../shared/types';
import type { SsstikSignal } from './ssstik-media';
import {
  ALLOWED_MEDIA_HOSTS,
  RATE_LIMIT_COOLDOWN_SECONDS,
  describeSignal,
  isAllowedMediaHost,
  isHdTierSignal,
  isTikTokOrAltHost,
  parseSsstikSignal,
  signalError,
  unwrapMediaUrl,
} from './ssstik-media';
import type { DownloadProvider, DownloadRequest, DownloadResult } from './types';

/**
 * Optional, unofficial adapter for the public SSSTik web form.
 *
 * It is deliberately not the default provider. Enabling it sends one public
 * TikTok post URL per episode to SSSTik, uses no TikTok account or session, and
 * stops on bot challenges or format changes instead of working around them.
 *
 * Per episode this performs: GET the shell (fresh single-use `tt` token) ->
 * POST the form -> unwrap the returned link -> stream one signature-verified MP4
 * into R2. See `docs/research/ssstik-frontend-analysis.md` for the protocol.
 */
const SSSTIK_ORIGIN = 'https://ssstik.io';
const SSSTIK_HOME = `${SSSTIK_ORIGIN}/`;
const SSSTIK_FORM = `${SSSTIK_ORIGIN}/abc?url=dl`;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
/** How many complete shell+POST rounds one episode may spend. */
const MAX_FORM_ATTEMPTS = 2;

type ResultLink = {
  kind: 'video' | 'audio';
  /** The href exactly as SSSTik published it. */
  url: string;
  /** True when that href base64-unwrapped to a different target. */
  decoded: boolean;
};

function enabled(env: Env): boolean {
  return flag(env.TIKTOK_SSTIK_ENABLED, false);
}

/**
 * Minimum spacing between two SSSTik requests from this isolate.
 *
 * Their backend emits `ssslimitexceed` and asks for ~10 s between posts, so a job
 * that walks a whole series has to pace itself. `JobService` already pins such a
 * job to `concurrency: 1`; this covers the remaining in-isolate back-to-back case.
 * Set `TIKTOK_SSTIK_MIN_INTERVAL_MS=0` to disable.
 */
function minIntervalMs(env: Env): number {
  // `0` is a real setting here (pacer off), so `num` must accept it rather than
  // treating it as "unset" and silently applying the default.
  return Math.max(0, Math.min(30_000, num(env, 'TIKTOK_SSTIK_MIN_INTERVAL_MS', 1_500, 0)));
}

/**
 * How long to wait after SSSTik answers `ssslimitexceed`. Their client tells the
 * user "~10 seconds", so 12 is the default; `TIKTOK_SSTIK_COOLDOWN_SECONDS=0`
 * makes the retry immediate (used by the test suite).
 */
function cooldownSeconds(env: Env): number {
  return Math.max(0, Math.min(120, num(env, 'TIKTOK_SSTIK_COOLDOWN_SECONDS', RATE_LIMIT_COOLDOWN_SECONDS, 0)));
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let lastRequestAt = 0;
async function pace(env: Env): Promise<void> {
  const minimum = minIntervalMs(env);
  if (minimum <= 0) return;
  const elapsed = Date.now() - lastRequestAt;
  lastRequestAt = Date.now();
  if (elapsed >= minimum) return;
  await sleep(minimum - elapsed);
}

/**
 * Reset the in-isolate pacer.
 *
 * Exported for the test suite only: `lastRequestAt` is module state, so a test
 * that enables pacing would otherwise inherit the previous test's timestamp.
 * Production code never calls it — the pacer is meant to carry over between
 * episodes of the same job.
 */
export function resetSsstikPacing(): void {
  lastRequestAt = 0;
}

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

/**
 * One public TikTok post, normalised to a single stable spelling.
 *
 * Accepted: `/@user/video/<id>`, `/@user/photo/<id>` (carousels have a cover
 * video SSSTik can return), legacy `/v|/embed|/player/v1/<id>`, and TikTok short
 * links (`vm.` / `vt.` / `/t/` / `/v/`) which SSSTik resolves server-side.
 * Rejected: profiles, playlists, non-TikTok hosts, non-HTTPS, embedded
 * credentials, explicit ports and tracking parameters.
 */
export function validatePostUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('SSSTik accepts one public TikTok video URL at a time. Analyze a TikTok share link first.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !isTikTokOrAltHost(host)
  ) {
    throw badRequest(
      'SSSTik only accepts a public HTTPS TikTok video post URL (not a profile, playlist, or a link to another site).',
    );
  }

  // Tracking data never identifies the post and should not be shared with a third party.
  url.search = '';
  url.hash = '';

  const parts = parseTikTokUrl(url);
  if (parts.kind === 'profile' || parts.kind === 'playlist') {
    throw badRequest(
      `SSSTik downloads one post at a time, but this is a ${parts.kind} link. Analyze it first so VTGrab can list every episode, then download the listing.`,
    );
  }
  if ((parts.kind === 'video' || parts.kind === 'photo') && parts.videoId) {
    return `https://www.tiktok.com/@${encodeURIComponent((parts.username ?? '_').replace(/^@/, ''))}/video/${parts.videoId}`;
  }
  // No explicit id: only a genuine TikTok short link is worth forwarding, because
  // SSSTik resolves those itself. Anything else we cannot vouch for.
  if (!isTikTokHost(host) || !isShortTikTokUrl(url)) {
    throw badRequest(
      'SSSTik needs one public TikTok video post URL (www.tiktok.com/@user/video/<id>), a photo post, or a TikTok short link.',
    );
  }
  return url.href;
}

// ---------------------------------------------------------------------------
// shell token
// ---------------------------------------------------------------------------

function extractPageToken(html: string): string | null {
  // Both spellings occur in the wild: a `var s_tt = '…'` global and an
  // `include-vals="tt:'…'"` HTMX attribute. A missing token is an honest stop
  // (changed page or bot challenge), never a reason to invent one.
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

// ---------------------------------------------------------------------------
// result parsing
// ---------------------------------------------------------------------------

/**
 * The real target of a result link, after unwrapping SSSTik's CDN encoding and
 * re-validating it. A decoded payload is attacker-influenced text, so it goes
 * through exactly the same allow-list and SSRF guard as a URL from a header.
 */
export function resolveMediaTarget(
  raw: string,
  cfg: ReturnType<typeof grabConfig>,
): { url: URL; decoded: boolean } {
  const unwrapped = unwrapMediaUrl(raw);
  let parsed: URL;
  try {
    parsed = new URL(unwrapped.url);
  } catch {
    throw badRequest('SSSTik returned an invalid media URL.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !isAllowedMediaHost(host)
  ) {
    throw badRequest(
      `SSSTik returned a media host outside VTGrab's safety allow-list: ${host || '(none)'}`,
      { allowedHosts: ALLOWED_MEDIA_HOSTS, decoded: unwrapped.decoded },
    );
  }
  return { url: safeUrl(parsed, cfg).url, decoded: unwrapped.decoded };
}

/**
 * Only explicit download buttons are considered; profile/ad links are ignored.
 *
 * Links are *unwrapped* here but deliberately **not** allow-list-checked: doing
 * the check here would silently drop a disallowed link and leave the operator
 * with a misleading "no MP4 link found". `resolveMediaTarget` runs at fetch time
 * instead, so the refusal names the host that was actually rejected.
 */
export function parseResultLinks(html: string): ResultLink[] {
  const results: ResultLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]{0,4096})>/gi)) {
    const attrs = tagAttributes(match[1]);
    const classes = (attrs.class ?? '').split(/\s+/);
    const kind = classes.includes('without_watermark') ? 'video' : classes.includes('music') ? 'audio' : null;
    if (!kind || !attrs.href) continue;
    let unwrapped: { url: string; decoded: boolean };
    try {
      unwrapped = unwrapMediaUrl(attrs.href);
    } catch {
      continue; // not even a parseable URL: nothing to fetch
    }
    const key = `${kind}:${unwrapped.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ kind, url: attrs.href, decoded: unwrapped.decoded });
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

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

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
  raw: string | URL,
  cfg: ReturnType<typeof grabConfig>,
  budget: Budget,
): Promise<{ response: Response; finalUrl: URL }> {
  // Unwrap + allow-list + SSRF-guard the starting point, then re-check every hop.
  let url = resolveMediaTarget(typeof raw === 'string' ? raw : raw.href, cfg).url;
  const maxHops = Math.min(cfg.maxRedirects, 5);
  for (let hop = 0; hop <= maxHops; hop += 1) {
    budget.take();
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(cfg.mediaTimeoutMs),
        headers: {
          ...baseHeaders(cfg, SSSTIK_HOME),
          accept: 'video/mp4,audio/mpeg,application/octet-stream;q=0.9',
        },
        cf: { cacheTtl: 0 },
      } as RequestInit);
    } catch (error) {
      throw badRequest(`Could not fetch the SSSTik media response: ${error instanceof Error ? error.message : String(error)}`);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      if (!location || hop === maxHops) {
        throw badRequest('SSSTik media redirected too many times or without a Location header.');
      }
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        throw badRequest('SSSTik media returned an invalid redirect target.');
      }
      // Every hop is re-validated: a wrapper may bounce through another wrapper
      // before landing on a signed regional CDN host.
      url = resolveMediaTarget(target.href, cfg).url;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw badRequest(`SSSTik media host returned HTTP ${response.status}.`);
    }
    return { response, finalUrl: url };
  }
  throw badRequest('Too many SSSTik media redirects.');
}

// ---------------------------------------------------------------------------
// MP4 verification
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// one shell + form round
// ---------------------------------------------------------------------------

interface FormRound {
  links: ResultLink[];
  /** Signal from `HX-Trigger`, when the backend sent one we recognise. */
  signal: SsstikSignal | null;
}

async function submitForm(
  videoUrl: string,
  env: Env,
  cfg: ReturnType<typeof grabConfig>,
  budget: Budget,
): Promise<FormRound> {
  await pace(env);
  const homeUrl = safeUrl(SSSTIK_HOME, cfg).url;
  const homeResponse = await fetchNoRedirect(homeUrl.href, cfg, budget, {
    method: 'GET',
    headers: baseHeaders(cfg, SSSTIK_HOME),
  });
  const cookie = cookieHeader(homeResponse.headers);
  const token = extractPageToken(await readSsstikHtml(homeResponse, homeUrl));
  if (!token) {
    throw badRequest('No public SSSTik form token found; its page may have changed or shown a bot challenge.');
  }

  await pace(env);
  const postResponse = await fetchNoRedirect(SSSTIK_FORM, cfg, budget, {
    method: 'POST',
    headers: {
      ...baseHeaders(cfg, SSSTIK_HOME),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
      origin: SSSTIK_ORIGIN,
      referer: SSSTIK_HOME,
      // HTMX sets these on the real form; SSSTik's backend keys on them.
      'hx-request': 'true',
      'hx-target': 'target',
      'hx-trigger': '_gcaptcha_pt',
      'hx-current-url': SSSTIK_HOME,
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ id: videoUrl, locale: 'en', tt: token }).toString(),
  });

  const signal = parseSsstikSignal(postResponse.headers);
  const html = await readSsstikHtml(postResponse, new URL(SSSTIK_FORM));
  return { links: parseResultLinks(html), signal };
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

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
        ? 'Unofficial and unstable. Sends one public TikTok post URL to SSSTik per episode, unwraps its CDN link, then streams one verified MP4 into R2. Paced serially (concurrency is pinned to 1). No TikTok login, captcha solving, or DRM bypass.'
        : 'Off by default. Explicitly opt in with TIKTOK_SSTIK_ENABLED=true; confirm rights and third-party URL sharing for every job.',
      docs: 'docs/research/ssstik-frontend-analysis.md',
    };
  }

  async start(request: DownloadRequest, env: Env): Promise<DownloadResult> {
    if (!enabled(env)) throw notConfigured('TikTok via SSSTik is off. Set TIKTOK_SSTIK_ENABLED=true to opt in.');
    const videoUrl = validatePostUrl(request.sourceUrl);
    const cfg = grabConfig(env);
    // Two full rounds (shell + POST) per attempt, plus the media fetch and its
    // redirects; 24 keeps a runaway wrapper chain from exhausting the invocation.
    const budget = new Budget(Math.min(cfg.maxSubrequests, 24));
    const maxBytes = Math.min(MAX_VIDEO_BYTES, cfg.maxVideoBytes);

    let links: ResultLink[] = [];
    let lastSignal: SsstikSignal | null = null;

    for (let attempt = 1; attempt <= MAX_FORM_ATTEMPTS; attempt += 1) {
      const round = await submitForm(videoUrl, env, cfg, budget);
      links = round.links;
      lastSignal = round.signal;

      const video = links.find((entry) => entry.kind === 'video');
      if (video) break;

      // No video link. Ask the backend signal what happened before giving up:
      // `tokenfail`, `limitexceed` and a transient upstream error are worth one
      // paced retry with a fresh token, a permanent verdict is not. The retry
      // sleeps in wall-clock time (no CPU), so it stays inside the invocation
      // budget; anything worse is left to the queue's own retry with backoff.
      const mapped = round.signal ? signalError(round.signal, cooldownSeconds(env)) : null;
      // `typeof === 'number'`, never a truthiness test: a configured cooldown of 0
      // is falsy but still means "this signal is retryable".
      if (
        mapped &&
        typeof mapped.retryAfterSeconds === 'number' &&
        attempt < MAX_FORM_ATTEMPTS &&
        budget.remaining >= 3
      ) {
        if (mapped.retryAfterSeconds > 0) await sleep(mapped.retryAfterSeconds * 1000);
        continue;
      }
      break;
    }

    const video = links.find((entry) => entry.kind === 'video');
    if (!video) {
      throw badRequest(describeFailure(links, lastSignal));
    }

    const media = await fetchMedia(video.url, cfg, budget);
    // The unwrap path is the fragile part of this adapter, so record which form
    // SSSTik used: operators need to know whether a change in behaviour came from
    // the path-embedded base64 or from the redirect-following branch.
    console.log(
      `[vtgrab][ssstik] episode ${request.episodeIndex}: link ${video.decoded ? 'unwrapped from base64' : 'followed as published'}, reached ${media.finalUrl.hostname}`,
    );
    const contentType = (media.response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType && !['video/mp4', 'application/octet-stream'].includes(contentType)) {
      await media.response.body?.cancel().catch(() => undefined);
      throw badRequest(`Refusing non-MP4 SSSTik response (${contentType}).`);
    }
    const lengthHeader = media.response.headers.get('content-length');
    const parsedLength = lengthHeader === null ? null : Number(lengthHeader);
    if (
      parsedLength !== null &&
      (!Number.isSafeInteger(parsedLength) || parsedLength < 8 || parsedLength > maxBytes)
    ) {
      await media.response.body?.cancel().catch(() => undefined);
      throw badRequest('SSSTik returned an invalid or oversized media Content-Length.');
    }

    const verified = await verifiedMp4Stream(media.response.body, parsedLength, maxBytes, request.onProgress);
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

/**
 * The most specific honest reason we can give when there is no MP4. A known
 * backend signal beats a guess, and an audio-only result is reported as such
 * rather than as a mysterious empty response.
 */
function describeFailure(links: ResultLink[], signal: SsstikSignal | null): string {
  // The backend's own verdict is more specific than anything we can infer from the
  // markup, so it wins when present — except for the HD-tier signals, which
  // describe SSSTik's paid upstream and say nothing about the missing MP4.
  if (signal && !isHdTierSignal(signal)) return describeSignal(signal);
  if (links.some((entry) => entry.kind === 'audio')) {
    return 'SSSTik returned only an audio (MP3) link for this post, so there is no MP4 to store.';
  }
  return 'SSSTik returned no MP4 link for this post (unavailable, challenged, or response format changed).';
}
