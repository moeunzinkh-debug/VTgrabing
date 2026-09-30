import type { Env } from '../env';
import { grabEnabled, isProduction, num } from '../env';

/**
 * Runtime configuration of the real HTTP grabber.
 *
 * Everything the grabber does is driven by plain (non secret) Worker vars so an
 * operator can tighten or loosen it without a code change. Defaults are chosen for
 * "grab the videos that are publicly reachable from this page":
 *
 *   GRAB_ENABLED                true   master switch for the sniff extractor + real downloader
 *   GRAB_ALLOWED_HOSTS          ""     optional comma separated allow-list (empty = any host)
 *   GRAB_DENIED_HOSTS           ""     optional comma separated deny-list (wins over allow-list)
 *   GRAB_ALLOW_PRIVATE_HOSTS    false  allow loopback/RFC1918/link-local targets (DEV ONLY)
 *   GRAB_MAX_REDIRECTS          5
 *   GRAB_PAGE_TIMEOUT_MS        20000  budget for the page + manifest + probe requests
 *   GRAB_MEDIA_TIMEOUT_MS       180000 idle budget for one media chunk / segment
 *   GRAB_MAX_PAGE_BYTES         4194304  (4 MiB) HTML/JSON that is scanned for media
 *   GRAB_MAX_VIDEO_BYTES        3221225472 (3 GiB) hard cap per downloaded object
 *   GRAB_CHUNK_BYTES            8388608  progressive download chunk = one R2 part
 *   GRAB_MAX_VIDEOS             200   maximum number of videos returned by one analyze
 *   GRAB_MAX_CANDIDATES         120   maximum media candidates probed per page
 *   GRAB_PROBE                  true   validate/size candidates with HEAD before returning them
 *   GRAB_FOLLOW_EMBEDS          true   also open same-page <iframe>/<embed> players
 *   GRAB_MAX_DEPTH              2      how many nested documents are opened (embeds/crawl)
 *   GRAB_CRAWL                  true   from a series page, follow episode-looking links
 *   GRAB_MAX_CRAWL_PAGES        24     maximum episode pages fetched per analyze
 *   GRAB_FETCH_CONCURRENCY      8      parallel probes / segment fetches
 *   GRAB_MAX_SUBREQUESTS        900    stay below the Worker sub-request limit
 *   GRAB_USER_AGENT             browser-like UA
 */
export interface GrabConfig {
  enabled: boolean;
  allowlist: string[];
  denylist: string[];
  allowPrivateHosts: boolean;
  maxRedirects: number;
  pageTimeoutMs: number;
  mediaTimeoutMs: number;
  maxPageBytes: number;
  maxVideoBytes: number;
  chunkBytes: number;
  maxVideos: number;
  maxCandidates: number;
  probe: boolean;
  followEmbeds: boolean;
  maxDepth: number;
  crawl: boolean;
  maxCrawlPages: number;
  fetchConcurrency: number;
  maxSubrequests: number;
  userAgent: string;
}

// Plain browser UA on purpose: a custom product token (e.g. "VTGrab/1.0") is a
// self-declared bot marker and gets the Worker 403-bot-checked at TikTok's edge.
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Minimum R2 accepts for a multipart part is 5 MiB; keep chunks well above that. */
export const MIN_CHUNK_BYTES = 5 * 1024 * 1024;

export function flag(raw: string | undefined, fallback: boolean): boolean {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) return false;
  return fallback;
}

function hostList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^www\./, '').replace(/^\*\./, ''))
    .filter((entry) => entry.length > 0);
}

let cached: { key: string; value: GrabConfig } | null = null;

export function grabConfig(env: Env): GrabConfig {
  const key = [
    env.GRAB_ENABLED,
    env.GRAB_ALLOWED_HOSTS,
    env.GRAB_DENIED_HOSTS,
    env.GRAB_ALLOW_PRIVATE_HOSTS,
    env.GRAB_MAX_REDIRECTS,
    env.GRAB_PAGE_TIMEOUT_MS,
    env.GRAB_MEDIA_TIMEOUT_MS,
    env.GRAB_MAX_PAGE_BYTES,
    env.GRAB_MAX_VIDEO_BYTES,
    env.GRAB_CHUNK_BYTES,
    env.GRAB_MAX_VIDEOS,
    env.GRAB_MAX_CANDIDATES,
    env.GRAB_PROBE,
    env.GRAB_FOLLOW_EMBEDS,
    env.GRAB_MAX_DEPTH,
    env.GRAB_CRAWL,
    env.GRAB_MAX_CRAWL_PAGES,
    env.GRAB_FETCH_CONCURRENCY,
    env.GRAB_MAX_SUBREQUESTS,
    env.GRAB_USER_AGENT,
    env.ENVIRONMENT,
  ].join('|');

  if (cached && cached.key === key) return cached.value;

  const chunkBytes = Math.max(
    MIN_CHUNK_BYTES,
    Math.min(64 * 1024 * 1024, num(env, 'GRAB_CHUNK_BYTES', MIN_CHUNK_BYTES * 2)),
  );

  const config: GrabConfig = {
    enabled: grabEnabled(env),
    allowlist: hostList(env.GRAB_ALLOWED_HOSTS),
    denylist: hostList(env.GRAB_DENIED_HOSTS),
    // Private/loopback targets are refused everywhere unless explicitly allowed, and
    // even then never in production (so a stray `dev` var cannot open an SSRF hole).
    allowPrivateHosts: flag(env.GRAB_ALLOW_PRIVATE_HOSTS, false) && !isProduction(env),
    maxRedirects: Math.min(10, num(env, 'GRAB_MAX_REDIRECTS', 5)),
    pageTimeoutMs: Math.max(1000, num(env, 'GRAB_PAGE_TIMEOUT_MS', 20_000)),
    mediaTimeoutMs: Math.max(5000, num(env, 'GRAB_MEDIA_TIMEOUT_MS', 180_000)),
    maxPageBytes: Math.max(64 * 1024, num(env, 'GRAB_MAX_PAGE_BYTES', 4 * 1024 * 1024)),
    maxVideoBytes: Math.max(
      1024 * 1024,
      num(env, 'GRAB_MAX_VIDEO_BYTES', 3 * 1024 * 1024 * 1024),
    ),
    chunkBytes,
    maxVideos: Math.max(1, Math.min(500, num(env, 'GRAB_MAX_VIDEOS', 200))),
    maxCandidates: Math.max(1, Math.min(400, num(env, 'GRAB_MAX_CANDIDATES', 120))),
    probe: flag(env.GRAB_PROBE, true),
    followEmbeds: flag(env.GRAB_FOLLOW_EMBEDS, true),
    maxDepth: Math.max(1, Math.min(3, num(env, 'GRAB_MAX_DEPTH', 2))),
    crawl: flag(env.GRAB_CRAWL, true),
    maxCrawlPages: Math.max(1, Math.min(100, num(env, 'GRAB_MAX_CRAWL_PAGES', 24))),
    fetchConcurrency: Math.max(1, Math.min(16, num(env, 'GRAB_FETCH_CONCURRENCY', 8))),
    maxSubrequests: Math.max(20, Math.min(1000, num(env, 'GRAB_MAX_SUBREQUESTS', 900))),
    userAgent: (env.GRAB_USER_AGENT ?? '').trim() || DEFAULT_USER_AGENT,
  };

  cached = { key, value: config };
  return config;
}

/** Base request headers a media host expects (hotlink protection keys on Referer). */
export function baseHeaders(cfg: GrabConfig, pageUrl?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': cfg.userAgent,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9,km;q=0.8',
  };
  if (pageUrl) {
    try {
      const url = new URL(pageUrl);
      headers.referer = url.toString();
      headers.origin = `${url.protocol}//${url.host}`;
    } catch {
      // Ignore an unusable referer, the request still goes out.
    }
  }
  return headers;
}
