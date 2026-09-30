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
  isShortTikTokUrl,
  isTikTokHost,
  parseOEmbed,
  parseTikTokUrl,
  parseVideoPage,
  type TikTokAnalysis,
  type TikTokVideoInfo,
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
 */

type Trace = (message: string) => void;

const OEMBED_ENDPOINT = 'https://www.tiktok.com/oembed';

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
    let resolved = await resolveShortUrl(url, cfg, signal, budget, trace);
    let parts = parseTikTokUrl(resolved);
    if (parts.kind === 'profile') {
      throw badRequest(
        'This is a profile link, not a video. Paste the link of one episode (or the series/playlist link).',
        { resolvedUrl: resolved.toString(), diagnostics },
      );
    }
    trace(`resolved: ${resolved.toString()}${parts.videoId ? ` (video ${parts.videoId})` : ''}`);

    // ---- 2. public page, then public oEmbed -------------------------------
    let info = await readPublicPage(resolved, cfg, signal, budget, trace);
    if (!info || info.origin !== 'page-json') {
      const embed = await readOEmbed(resolved, cfg, signal, budget, trace);
      // The page meta tags (if any) win for caption, oEmbed fills the gaps.
      info = mergeInfo(info, embed);
    }
    if (!info) {
      throw badRequest(
        'TikTok returned no public data for this link (private/removed video, region block, or a bot-check page). ' +
          'VTGrab does not bypass bot checks or log in; use an authorized source for this link.',
        { resolvedUrl: resolved.toString(), diagnostics },
      );
    }
    trace(`public data from: ${info.origin}`);

    // The short link may have been unresolvable (bot check) while the public data
    // still names the video: adopt the discovered id so the listing is complete and
    // downstream metadata shows the long URL.
    if (info.id && (isShortTikTokUrl(resolved) || parseTikTokUrl(resolved).kind === 'unknown')) {
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
      const unresolved = isShortTikTokUrl(resolved) || parseTikTokUrl(resolved).kind === 'unknown';
      throw badRequest(
        unresolved
          ? 'Could not identify a video id in this link: TikTok refused to resolve the short link for a server-side ' +
            'tool (bot check) and no public data names the video. Open the link once in a browser and paste the ' +
            'long address it lands on (www.tiktok.com/@…/video/…).'
          : 'Could not identify a video id in this link.',
        { resolvedUrl: resolved.toString(), diagnostics },
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
        ? 'Resolves tiktok.com short links, reads the public page / oEmbed (no login, no cookies, no bot-check bypass), classifies mini-drama vs normal video and lists episodes. Listing only: no media is extracted.'
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

/**
 * Follow a short link one hop at a time. Every hop must stay on tiktok.com and pass the
 * same SSRF policy as any other grab request, so a short link can never be used to make
 * the Worker call somewhere else.
 */
export async function resolveShortUrl(
  input: URL,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<URL> {
  if (!isShortTikTokUrl(input)) return stripTracking(input);

  let current = safeUrl(input, cfg).url;
  for (let hop = 0; hop <= cfg.maxRedirects; hop += 1) {
    budget.take();
    const timeout = AbortSignal.timeout(cfg.pageTimeoutMs);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: baseHeaders(cfg),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw badRequest(`Could not resolve the short link: ${error instanceof Error ? error.message : String(error)}`);
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
      if (!isTikTokHost(next.hostname)) {
        throw badRequest(`The short link redirects to ${next.hostname}, which is not TikTok. Refusing to follow it.`);
      }
      trace(`short link hop ${hop + 1}: ${current.host}${current.pathname} -> ${next.host}${next.pathname}`);
      next = safeUrl(next, cfg).url;
      // A long video URL is the goal; stop as soon as we have one.
      if (parseTikTokUrl(next).kind !== 'unknown' && !isShortTikTokUrl(next)) return stripTracking(next);
      current = next;
      continue;
    }
    if (response.status >= 400) {
      // No redirect and no page: TikTok's edge bot-checked the hop. Say so in the
      // diagnostics instead of silently pretending the short URL was the destination.
      trace(`short link hop returned HTTP ${response.status} with no redirect (TikTok bot check?) - nothing left to follow`);
      void response.body?.cancel().catch(() => undefined);
      return stripTracking(current);
    }
    // A 2xx final page. If it is still a short/unknown URL, the destination may only
    // exist inside the HTML (interstitial JS redirect, og:url) - sniff it out.
    if (isShortTikTokUrl(current) || parseTikTokUrl(current).kind === 'unknown') {
      const body = await readTextLimited(response, Math.min(cfg.maxPageBytes, 512 * 1024), current);
      const ref = findVideoRefInHtml(body.text);
      if (ref) {
        trace(`short link final page names the video directly: ${ref.url}`);
        return new URL(ref.url);
      }
      trace(`short link final page (HTTP ${response.status}) carries no long URL`);
    } else {
      void response.body?.cancel().catch(() => undefined);
    }
    return stripTracking(current);
  }
  throw badRequest(`Too many redirects (>${cfg.maxRedirects}) while resolving the short link.`);
}

// ---------------------------------------------------------------------------
// public data
// ---------------------------------------------------------------------------

async function readPublicPage(
  url: URL,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<TikTokVideoInfo | null> {
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
      return null;
    }
    const body = await readTextLimited(response, cfg.maxPageBytes, finalUrl);
    const info = parseVideoPage(body.text, finalUrl);
    if (!info) trace('page had no embedded video data (bot-check, login wall or changed layout)');
    return info;
  } catch (error) {
    trace(`public page not readable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
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

function mergeInfo(primary: TikTokVideoInfo | null, secondary: TikTokVideoInfo | null): TikTokVideoInfo | null {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return {
    ...secondary,
    ...primary,
    caption: primary.caption || secondary.caption,
    username: primary.username ?? secondary.username,
    nickname: primary.nickname ?? secondary.nickname,
    cover: primary.cover ?? secondary.cover,
    hashtags: [...new Set([...primary.hashtags, ...secondary.hashtags])],
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
      canonicalVideoUrl: analysis.videoId ? canonicalVideoUrl(analysis.username, analysis.videoId) : undefined,
      diagnostics: diagnostics.slice(0, 60),
      generatedBy: 'TikTokExtractor',
    },
  };
}
