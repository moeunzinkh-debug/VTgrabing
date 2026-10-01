import { badRequest } from '../../core/errors';
import type { Env } from '../../env';
import { grabEnabled } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import { baseHeaders, grabConfig, type GrabConfig } from '../../grab/config';
import { checkHostname, safeUrl } from '../../grab/guard';
import { Budget, grabFetch, readTextLimited } from '../../grab/net';
import {
  analyzeVideo,
  canonicalVideoUrl,
  findVideoRefInHtml,
  findVideoRefInUrl,
  inspectVideoPage,
  isShortTikTokUrl,
  isTikTokHost,
  linkOnlyInfo,
  parseOEmbed,
  parseTikTokUrl,
  type TikTokAnalysis,
  type TikTokUrlParts,
  type TikTokVideoInfo,
  type TikTokVideoRef,
  type VideoDetailStatus,
} from '../../grab/tiktok';
import type { ExtractedSeries, SourceExtractor } from './types';

/**
 * TikTok link analyzer.
 *
 *   paste URL
 *     -> resolve short URL            (vm.tiktok.com / vt.tiktok.com / tiktok.com/t/…)
 *     -> read the PUBLIC page, or the public oEmbed when the page is walled
 *     -> mini-drama or normal video?  (explicit fields, hashtags, episode markers, playlist)
 *     -> title, episode number, episode list
 *     -> listed in the tool
 *
 * This extractor only *lists*. It reads what a logged-out visitor receives, sends no
 * cookies or tokens, never tries to get past a captcha / bot wall and never extracts
 * media URLs, so its episodes carry no streams and are marked `listOnly`. When the
 * operator is licensed to use a catalog API, `AuthorizedHttpExtractor` (registry
 * position 1) takes over for the hosts in `SOURCE_ALLOWED_HOSTS` and supplies the
 * complete, authoritative episode list instead.
 *
 * When TikTok refuses a server-side reader the tool says so instead of failing
 * silently: a link that still names its video is listed as that one video (flagged
 * `degraded`, kind `unknown`), a short link nobody could open is listed as-is, and
 * every other dead end is an error that names its cause (`details.reason`) and carries
 * the step-by-step `details.diagnostics` the UI shows under "technical details".
 */

type Trace = (message: string) => void;

const OEMBED_ENDPOINT = 'https://www.tiktok.com/oembed';

/** Machine-readable cause of an analyze failure; the UI shows a Khmer explanation per code. */
export type TikTokFailureReason =
  | 'profile-link'
  | 'playlist-link'
  | 'short-link-not-found'
  | 'unavailable'
  | 'no-public-data'
  | 'no-video-id';

function failure(reason: TikTokFailureReason, message: string, resolved: URL | undefined, diagnostics: string[]) {
  return badRequest(message, {
    reason,
    ...(resolved ? { resolvedUrl: resolved.toString() } : {}),
    diagnostics,
  });
}

const UNRESOLVED_SHORT_NOTE =
  'TikTok would not let VTGrab open this short link from a server (it answers with a bot check), so the video could not ' +
  'be identified. It is listed as-is so the optional SSSTik provider, which accepts short links, can try it. ' +
  'For the title and series, open the link in a browser and paste the long address it lands on (www.tiktok.com/@…/video/…).';

export class TikTokExtractor implements SourceExtractor {
  readonly key = 'tiktok';
  readonly label = 'TikTok link analyzer (public page: mini-drama or normal video, episode list)';
  readonly kind = 'http' as const;

  isConfigured(env: Env): boolean {
    return grabEnabled(env);
  }

  canHandle(url: URL, env: Env): boolean {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!isTikTokHost(url.hostname)) return false;
    const cfg = grabConfig(env);
    return cfg.enabled && checkHostname(url.hostname, cfg).ok;
  }

  async extract(url: URL, env: Env, signal?: AbortSignal): Promise<ExtractedSeries> {
    const cfg = grabConfig(env);
    if (!cfg.enabled) throw badRequest('The link analyzer is disabled (set GRAB_ENABLED=true).');

    const budget = new Budget(Math.min(cfg.maxSubrequests, 30));
    const diagnostics: string[] = [];
    const trace: Trace = (message) => {
      diagnostics.push(message);
      console.log(`[vtgrab][tiktok] ${message}`);
    };

    // ---- 1. resolve the short URL -----------------------------------------
    const resolution = await resolveShortLink(url, cfg, signal, budget, trace);
    let resolved = resolution.url;
    let parts = parseTikTokUrl(resolved);
    trace(
      `resolved: ${resolved.toString()}${parts.videoId ? ` (video ${parts.videoId})` : ''}${resolution.resolved ? '' : ' [short link NOT resolved]'}`,
    );
    if (parts.kind === 'profile') {
      throw failure(
        'profile-link',
        'This is a profile link, not a video. Paste the link of one episode (or the series/playlist link).',
        resolved,
        diagnostics,
      );
    }
    if (resolution.notFound) {
      throw failure(
        'short-link-not-found',
        'TikTok says this short link does not exist (HTTP 404). It may be mistyped, expired or deleted: copy the link again from TikTok.',
        resolved,
        diagnostics,
      );
    }

    // ---- 2. public page, then public oEmbed -------------------------------
    const isPlaylist = parts.kind === 'playlist';
    let info: TikTokVideoInfo | null = null;
    let unavailable: VideoDetailStatus | null = null;
    if (resolution.resolved) {
      const page = await readPublicPage(postUrlFor(resolved, parts), parts, cfg, signal, budget, trace);
      info = page.info;
      unavailable = page.status;
    }
    if (!isPlaylist && (!info || info.origin !== 'page-json')) {
      const embed = await readOEmbed(postUrlFor(resolved, parts), cfg, signal, budget, trace);
      // The page meta tags (if any) win for caption, oEmbed fills the gaps.
      info = mergeInfo(info, embed);
    }
    // A playlist link is only worth listing when its page really enumerates the videos.
    if (isPlaylist && !(info?.playlist && info.playlist.items.length > 0)) info = null;

    // The link itself may already name the video even when no page did.
    if (info && !info.id && parts.videoId) {
      info = { ...info, id: parts.videoId, username: info.username ?? parts.username };
      trace(`video id taken from the link: ${parts.videoId}`);
    }

    if (!info) {
      if (unavailable) {
        throw failure(
          'unavailable',
          `TikTok reports this video as unavailable (code ${unavailable.code}): it may be private, removed, or blocked for this server's region / IP address. ` +
            'VTGrab does not log in or bypass blocks.',
          resolved,
          diagnostics,
        );
      }
      if (parts.videoId) {
        // Blocked, not missing: the link still carries the video id. List that one video,
        // clearly labelled, instead of failing a request that SSSTik could still serve.
        info = linkOnlyInfo(parts);
        trace('TikTok returned no public data; listing the video named by the link itself');
      } else if (isPlaylist) {
        throw failure(
          'playlist-link',
          "This is a TikTok playlist / collection link. TikTok hands a playlist's episode list only to its own app (through a signed API), " +
            "so a public page read cannot list it. Open the series in TikTok, tap any one episode and paste that episode's link here.",
          resolved,
          diagnostics,
        );
      } else if (!resolution.resolved) {
        trace('short link could not be opened and no public data names the video; listing the link as-is');
        return unresolvedSeries(url, resolved, diagnostics);
      } else {
        throw failure(
          'no-public-data',
          `TikTok returned no public data for this link (it ended on ${resolved.host}${resolved.pathname}, which is not a video page). ` +
            'The video may be private or removed, or TikTok bot-checked the request. VTGrab does not bypass bot checks or log in; ' +
            'paste the long link of one episode (www.tiktok.com/@…/video/…).',
          resolved,
          diagnostics,
        );
      }
    }
    trace(`public data from: ${info.origin}`);

    // The short link may have been unresolvable while the public data still names the
    // video: adopt the discovered id so the listing is complete and downstream metadata
    // shows the long URL.
    if (info.id && !parts.videoId && !isPlaylist) {
      resolved = new URL(canonicalVideoUrl(info.username, info.id));
      parts = parseTikTokUrl(resolved);
      trace(`video id recovered from ${info.origin}: ${info.id}${info.username ? ` (@${info.username})` : ''}`);
    }

    // ---- 3-4. classify, title, episode number, episode list ---------------
    const analysis = analyzeVideo(info, parts.username);
    trace(
      `verdict: ${analysis.kind} (${analysis.classification.confidence} confidence) - ${analysis.classification.signals.join('; ')}`,
    );
    if (analysis.episodes.length === 0) {
      throw failure(
        'no-video-id',
        'TikTok did not say which video this link points to, so VTGrab cannot list it. If this is a short link, open it in a ' +
          'browser and paste the long address it lands on (www.tiktok.com/@…/video/…).',
        resolved,
        diagnostics,
      );
    }
    return toSeries(analysis, info, url, resolved, diagnostics);
  }

  describe(env: Env): ProviderDescriptor {
    const cfg = grabConfig(env);
    return {
      key: this.key,
      label: this.label,
      kind: 'http',
      available: cfg.enabled,
      configured: cfg.enabled,
      reason: cfg.enabled
        ? 'Resolves tiktok.com short links, reads the public page / oEmbed (no login, no cookies, no bot-check bypass), classifies mini-drama vs normal video and lists episodes. Listing only: no media is extracted. When TikTok blocks the server it lists the bare link and says so.'
        : 'Disabled: set GRAB_ENABLED=true.',
      docs: 'README.md#tiktok-link-analysis',
    };
  }
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

/** Drop tracking parameters; the video is identified by its path alone. */
function stripTracking(url: URL): URL {
  const clean = new URL(url.toString());
  clean.search = '';
  clean.hash = '';
  return clean;
}

/** A redirector answers in well under a second; do not let one hop eat the analyze budget. */
const HOP_TIMEOUT_MS = 8_000;

interface HeaderProfile {
  label: string;
  /** `undefined` = send nothing of our own. */
  headers: Record<string, string> | undefined;
}

/**
 * The two honest ways to ask a short link where it goes, in order:
 *
 *  1. platform defaults: no `User-Agent` or other headers of ours. Other Workers-hosted
 *     link tools resolve TikTok short links this way, and a plain client is the one
 *     request that cannot be mistaken for browser impersonation.
 *  2. the configured browser-like headers (`GRAB_USER_AGENT`).
 *
 * Neither presents a crawler identity or any cookie, and a refusal is never retried
 * with anything cleverer: it is reported.
 */
function headerProfiles(cfg: GrabConfig): HeaderProfile[] {
  return [
    { label: 'default headers', headers: undefined },
    { label: 'browser headers', headers: baseHeaders(cfg) },
  ];
}

/** `/t/<code>` only answers on www.tiktok.com; the bare and `m.` hosts reply 404 to every path. */
function shortLinkRequestUrl(url: URL): URL {
  const host = url.hostname.toLowerCase();
  if (/^\/t\/[\w-]+\/?$/.test(url.pathname) && (host === 'tiktok.com' || host === 'm.tiktok.com')) {
    const rewritten = new URL(url.toString());
    rewritten.hostname = 'www.tiktok.com';
    return rewritten;
  }
  return url;
}

type HopResult =
  | { kind: 'redirect'; status: number; next: URL }
  | { kind: 'named'; status: number; ref: TikTokVideoRef }
  | { kind: 'refused'; status: number }
  | { kind: 'empty'; status: number }
  | { kind: 'failed'; error: string };

async function requestHop(
  current: URL,
  headers: HeaderProfile['headers'],
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
): Promise<HopResult> {
  const timeout = AbortSignal.timeout(Math.min(cfg.pageTimeoutMs, HOP_TIMEOUT_MS));
  let response: Response;
  try {
    response = await fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  const location = response.headers.get('location');
  if (location && response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw badRequest(`The short link redirected to an invalid location "${location.slice(0, 200)}"`);
    }
    return { kind: 'redirect', status: response.status, next };
  }
  if (response.status >= 400) {
    void response.body?.cancel().catch(() => undefined);
    return { kind: 'refused', status: response.status };
  }
  // A 2xx page: the destination may only exist inside the HTML (interstitial JS redirect, og:url).
  try {
    const body = await readTextLimited(response, Math.min(cfg.maxPageBytes, 512 * 1024), current);
    const ref = findVideoRefInHtml(body.text);
    return ref ? { kind: 'named', status: response.status, ref } : { kind: 'empty', status: response.status };
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

export interface ShortLinkResolution {
  /** Where the chain ended: a long URL when it resolved, else the last short URL reached. */
  url: URL;
  /** False when TikTok would not say where the short link goes. */
  resolved: boolean;
  /** Every refusal was HTTP 404 / 410: the code does not exist (typo, expired, deleted). */
  notFound: boolean;
}

/**
 * Follow a short link one hop at a time. Every hop must stay on tiktok.com and pass the
 * same SSRF policy as any other grab request, so a short link can never be used to make
 * the Worker call somewhere else. Only short hops are ever requested: as soon as the
 * chain reaches a long URL (video, playlist, profile or anything else) it stops there.
 */
export async function resolveShortLink(
  input: URL,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<ShortLinkResolution> {
  if (!isShortTikTokUrl(input)) return { url: stripTracking(input), resolved: true, notFound: false };

  const profiles = headerProfiles(cfg);
  let preferred = 0;
  let current = safeUrl(shortLinkRequestUrl(input), cfg).url;

  for (let hop = 0; hop <= cfg.maxRedirects; hop += 1) {
    const order = [preferred, ...profiles.keys()].filter((index, position, all) => all.indexOf(index) === position);
    const refusals: number[] = [];
    const failures: string[] = [];
    let empties = 0;
    let result: HopResult | undefined;
    let used = preferred;

    for (const index of order) {
      budget.take();
      const profile = profiles[index];
      const attempt = await requestHop(current, profile.headers, cfg, signal);
      if (attempt.kind === 'redirect' || attempt.kind === 'named') {
        result = attempt;
        used = index;
        break;
      }
      const where = `${current.host}${current.pathname} [${profile.label}]`;
      if (attempt.kind === 'refused') {
        refusals.push(attempt.status);
        trace(`short link ${where}: HTTP ${attempt.status} with no redirect (TikTok bot check?)`);
      } else if (attempt.kind === 'empty') {
        empties += 1;
        trace(`short link ${where}: HTTP ${attempt.status} page carries no long URL`);
      } else {
        failures.push(attempt.error);
        trace(`short link ${where}: request failed (${attempt.error})`);
      }
    }

    if (result?.kind === 'named') {
      trace(`short link final page names the video directly: ${result.ref.url}`);
      return { url: new URL(result.ref.url), resolved: true, notFound: false };
    }

    if (result?.kind === 'redirect') {
      preferred = used;
      let next = result.next;
      if (!isTikTokHost(next.hostname)) {
        throw badRequest(`The short link redirects to ${next.hostname}, which is not TikTok. Refusing to follow it.`);
      }
      trace(`short link hop ${hop + 1}: ${current.host}${current.pathname} -> ${next.host}${next.pathname}`);
      next = safeUrl(next, cfg).url;
      if (!isShortTikTokUrl(next)) {
        // The destination. A login / consent detour keeps the wanted page in its query.
        const pointer = parseTikTokUrl(next).videoId ? null : findVideoRefInUrl(next);
        return { url: pointer ? new URL(pointer.url) : stripTracking(next), resolved: true, notFound: false };
      }
      current = safeUrl(shortLinkRequestUrl(next), cfg).url;
      continue;
    }

    // Every way of asking came back empty-handed.
    if (refusals.length === 0 && empties === 0 && failures.length > 0) {
      // Nothing answered at all: that is a network problem, not TikTok saying no.
      throw badRequest(`Could not resolve the short link: ${failures[failures.length - 1]}`);
    }
    const notFound =
      failures.length === 0 && empties === 0 && refusals.length > 0 && refusals.every((status) => status === 404 || status === 410);
    trace(
      notFound
        ? `short link ${current.host}${current.pathname} does not exist (HTTP ${refusals[0]})`
        : `short link ${current.host}${current.pathname} could not be resolved: TikTok's redirector refused this server`,
    );
    return { url: stripTracking(current), resolved: false, notFound };
  }
  throw badRequest(`Too many redirects (>${cfg.maxRedirects}) while resolving the short link.`);
}

/** `resolveShortLink` without the verdict: the URL the chain ended on. */
export async function resolveShortUrl(
  input: URL,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<URL> {
  return (await resolveShortLink(input, cfg, signal, budget, trace)).url;
}

// ---------------------------------------------------------------------------
// public data
// ---------------------------------------------------------------------------

const STANDARD_POST_PATH = /^\/@[^/]+\/(?:video|photo)\/\d{6,25}\/?$/;

/**
 * The URL to ask TikTok about a post. oEmbed and the page only know the standard
 * `www.tiktok.com/@user/video/<id>` spelling; the legacy `/v/<id>.html`, embed and
 * mobile-host forms carry the same id, so they are rewritten (username unknown = `@_`).
 */
function postUrlFor(resolved: URL, parts: TikTokUrlParts): URL {
  if (!parts.videoId) return resolved;
  if (resolved.hostname.toLowerCase() === 'www.tiktok.com' && STANDARD_POST_PATH.test(resolved.pathname)) {
    return stripTracking(resolved);
  }
  return new URL(canonicalVideoUrl(parts.username, parts.videoId));
}

async function readPublicPage(
  url: URL,
  requested: TikTokUrlParts,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<{ info: TikTokVideoInfo | null; status: VideoDetailStatus | null }> {
  try {
    const { response, url: finalUrl } = await grabFetch(
      url,
      cfg,
      {
        headers: { ...baseHeaders(cfg), accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
        acceptedStatuses: [200],
        signal,
      },
      budget,
    );
    if (!isTikTokHost(finalUrl.hostname)) {
      trace(`page redirected off TikTok (${finalUrl.hostname}); ignored`);
      return { info: null, status: null };
    }
    if (finalUrl.pathname !== url.pathname) {
      trace(`page was served from ${finalUrl.host}${finalUrl.pathname}, not the requested ${url.pathname}`);
    }
    const body = await readTextLimited(response, cfg.maxPageBytes, finalUrl);
    const reading = inspectVideoPage(body.text, finalUrl, requested);
    for (const note of reading.notes) trace(note);
    if (!reading.info && reading.notes.length === 0) {
      trace('page had no embedded video data (bot-check, login wall or changed layout)');
    }
    return { info: reading.info, status: reading.status };
  } catch (error) {
    trace(`public page not readable: ${error instanceof Error ? error.message : String(error)}`);
    return { info: null, status: null };
  }
}

async function readOEmbed(
  url: URL,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<TikTokVideoInfo | null> {
  try {
    const endpoint = `${OEMBED_ENDPOINT}?url=${encodeURIComponent(url.toString())}`;
    const { response } = await grabFetch(
      endpoint,
      cfg,
      { headers: { ...baseHeaders(cfg), accept: 'application/json' }, acceptedStatuses: [200], signal },
      budget,
    );
    const body = await readTextLimited(response, 256 * 1024, new URL(endpoint));
    return parseOEmbed(JSON.parse(body.text) as unknown, url);
  } catch (error) {
    trace(`oEmbed not readable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Combine two readings of the same video. A field is taken from `primary` only when it
 * actually has a value: spreading would let an explicit `id: undefined` from a page
 * that could not name the video erase the id the other source (or the link) provided.
 */
export function mergeInfo(primary: TikTokVideoInfo | null, secondary: TikTokVideoInfo | null): TikTokVideoInfo | null {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    id: primary.id ?? secondary.id,
    caption: primary.caption || secondary.caption,
    username: primary.username ?? secondary.username,
    nickname: primary.nickname ?? secondary.nickname,
    durationSeconds: primary.durationSeconds ?? secondary.durationSeconds,
    cover: primary.cover ?? secondary.cover,
    createdAt: primary.createdAt ?? secondary.createdAt,
    hashtags: [...new Set([...primary.hashtags, ...secondary.hashtags])],
    playlist: primary.playlist ?? secondary.playlist,
    dramaField: primary.dramaField ?? secondary.dramaField,
    origin: primary.origin,
  };
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

function toSeries(
  analysis: TikTokAnalysis,
  info: TikTokVideoInfo,
  submitted: URL,
  resolved: URL,
  diagnostics: string[],
): ExtractedSeries {
  const playlistId = info.playlist?.id;
  const canonicalUrl =
    analysis.kind === 'mini-drama' && playlistId
      ? `tiktok:playlist:${playlistId}`
      : `tiktok:video:${analysis.videoId ?? analysis.episodes[0].videoId}`;

  const synopsis =
    analysis.kind === 'mini-drama'
      ? [
          analysis.username ? `@${analysis.username}` : '',
          analysis.totalEpisodes ? `${analysis.totalEpisodes} episodes` : '',
        ]
          .filter(Boolean)
          .join(' · ') || undefined
      : analysis.username
        ? `@${analysis.username}`
        : undefined;

  return {
    sourceKey: 'tiktok',
    title: analysis.title.slice(0, 200),
    synopsis,
    posterUrl: info.cover,
    canonicalUrl,
    sourceUrl: submitted.toString(),
    episodes: analysis.episodes.map((episode) => ({
      index: episode.index,
      title: episode.title.slice(0, 500) || `Episode ${episode.episodeNumber ?? episode.index}`,
      url: episode.url,
      durationSeconds: episode.durationSeconds,
      thumbnailUrl: episode.cover,
      streams: [],
      metadata: {
        platform: 'tiktok',
        listOnly: true,
        videoId: episode.videoId,
        episodeNumber: episode.episodeNumber,
        current: episode.current,
      },
    })),
    metadata: {
      platform: 'tiktok',
      contentKind: analysis.kind,
      confidence: analysis.classification.confidence,
      signals: analysis.classification.signals,
      videoId: analysis.videoId,
      username: analysis.username,
      resolvedUrl: resolved.toString(),
      currentEpisodeNumber: analysis.currentEpisodeNumber,
      totalEpisodes: analysis.totalEpisodes,
      listComplete: analysis.listComplete,
      listNote: analysis.listNote,
      dataOrigin: info.origin,
      // Only the link was known: flagged so the API never serves this from its cache.
      ...(analysis.kind === 'unknown' ? { degraded: true } : {}),
      canonicalVideoUrl: analysis.videoId ? canonicalVideoUrl(analysis.username, analysis.videoId) : undefined,
      diagnostics: diagnostics.slice(0, 60),
      generatedBy: 'TikTokExtractor',
    },
  };
}

/**
 * A short link nothing could open: list the link itself as the one post. The optional
 * SSSTik provider accepts short links as they are, so this keeps the pipeline usable;
 * the result says plainly (kind `unknown`, low confidence, `degraded`) that nothing was read.
 */
function unresolvedSeries(submitted: URL, shortUrl: URL, diagnostics: string[]): ExtractedSeries {
  const link = stripTracking(shortUrl);
  const code = link.pathname.split('/').filter(Boolean).pop() ?? link.host;
  return {
    sourceKey: 'tiktok',
    title: `TikTok short link ${code}`,
    synopsis: 'Not identified: TikTok blocked the server from opening this short link',
    canonicalUrl: `tiktok:short:${code}`,
    sourceUrl: submitted.toString(),
    episodes: [
      {
        index: 1,
        title: `TikTok post (short link ${code})`,
        url: link.toString(),
        streams: [],
        metadata: { platform: 'tiktok', listOnly: true, unresolvedShortLink: true },
      },
    ],
    metadata: {
      platform: 'tiktok',
      contentKind: 'unknown',
      confidence: 'low',
      signals: ['TikTok refused to open the short link, so nothing about the video could be read'],
      resolvedUrl: link.toString(),
      listComplete: false,
      listNote: UNRESOLVED_SHORT_NOTE,
      dataOrigin: 'link',
      degraded: true,
      diagnostics: diagnostics.slice(0, 60),
      generatedBy: 'TikTokExtractor',
    },
  };
}
