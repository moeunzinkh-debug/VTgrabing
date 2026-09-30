import { normalizeQualityLabel, type MediaKind, resolveFormat } from './media-types';

/**
 * Media discovery inside a fetched document.
 *
 * This is the part a real grabber lives or dies by, so it looks in every place a
 * video URL is actually published:
 *
 *   1. markup      `<video src>`, `<source>`, `<a href="*.mp4">`, `<iframe>` players
 *   2. open graph  `og:video`, `og:video:url`, `og:video:secure_url`, `twitter:player:stream`
 *   3. data attrs  `data-src`, `data-video`, `data-hls`, `data-mp4`, `data-file`, ...
 *   4. players     jwplayer/videojs style `sources: [{file|src, label|res, type}]`
 *   5. JSON-LD     `VideoObject.contentUrl`, `episodes[]`, `video:` arrays
 *   6. raw scan    any remaining `.mp4|.m3u8|.webm|...` string in the document
 *
 * Everything it returns is a *candidate*: the caller validates the ones it is
 * unsure about with a HEAD request (see `sniff.ts` + the http-sniff extractor).
 */

export type FoundBy =
  | 'video-tag'
  | 'source-tag'
  | 'iframe'
  | 'embed'
  | 'anchor'
  | 'meta'
  | 'link'
  | 'data-attribute'
  | 'player-config'
  | 'json-ld'
  | 'raw-scan'
  | 'manifest';

export interface SniffedCandidate {
  url: string;
  kind: MediaKind;
  container: string;
  foundBy: FoundBy;
  title?: string;
  posterUrl?: string;
  quality?: string;
  bitrateKbps?: number;
  width?: number;
  height?: number;
  /** Where this candidate was found (document URL). */
  pageUrl: string;
  depth: number;
  /** Segment/playlist hints extracted from the surrounding markup. */
  orderHint?: number;
}

export interface SniffResult {
  candidates: SniffedCandidate[];
  /** `<iframe>`/`<embed>` player documents worth opening (same page, depth +1). */
  embeds: string[];
  /** Episode-looking page links, used when a page is a series index. */
  episodeLinks: string[];
  pageTitle?: string;
  pageImage?: string;
  pageDescription?: string;
  diagnostics: string[];
}

/** Any string that ends in a media extension, tolerating a query string. */
const MEDIA_URL_PATTERN =
  /[A-Za-z0-9_\-./:?=&%#'+]+?\.(?:mp4|m4v|mov|webm|mkv|ogv|avi|flv|3gp|mpg|mpeg|vob|ts|m2ts|m4s|m3u8|m3u|mpd|mp3|m4a|aac|opus|oga|wav|flac)(?=[?#'"\s)\<>,;]|$)/gi;

/**
 * Quote aware patterns for a single JS object literal (`{ file: "x.mp4", label: ... }`).
 * A key is preferred when the config names one, but plenty of players assign a bare
 * quoted path, so a second, keyless pattern catches those too. Both are non-global on
 * purpose: a global regex plus `.exec()` would leak `lastIndex` between documents.
 */
const LITERAL_KEYED_URL =
  /["']?(?:file|src|source|sources|url|href|video|media|stream|hls|dash|mp4|m3u8)["']?\s*[:=]\s*["']((?:https?:\/\/|\/\/|\/)?[^\s"'<>\\]*?\.(?:mp4|m4v|mov|webm|mkv|ogv|avi|flv|3gp|mpg|mpeg|ts|m2ts|m4s|m3u8|mpd|mp3|m4a|aac|opus|oga|wav|flac)(?:\?[^\s"'<>\\]*)?)["']/i;

const LITERAL_MEDIA_URL =
  /["']((?:https?:\/\/|\/\/|\/)?[^\s"'<>\\]*?\.(?:mp4|m4v|mov|webm|mkv|ogv|avi|flv|3gp|mpg|mpeg|ts|m2ts|m4s|m3u8|mpd|mp3|m4a|aac|opus|oga|wav|flac)(?:\?[^\s"'<>\\]*)?)["']/i;

const DATA_ATTRIBUTE_PATTERN =
  /\bdata-(?:src|video|videourl|mp4|mp4url|hls|hlsvideo|dash|file|fileurl|url|urlmp4|playback|source|sources|media|mediaurl)\s*=\s*("([^"]*)"|'([^']*)')/gi;

const EPISODE_LINK_PATTERN =
  /(^|[/=?&_-])(episode|episodes|ep|e|part|chapter|clip|video|movie|p)([/_-]?(\d{1,4}))?([/?=&_-]|$)/i;

/** Decode the entities a URL can be wrapped in, plus JS string escapes. */
export function decodeCandidate(raw: string): string {
  let value = raw.trim();
  // JS: "\\/video\\u0026a.mp4"
  value = value.replace(/\\u002[fF]/g, '&').replace(/\\u0026/g, '&').replace(/\\x2[fF]/g, '&');
  value = value.replace(/\\(["'/\\])/g, '$1');
  // HTML entities
  value = value
    .replace(/&amp;/gi, '&')
    .replace(/&#0?38;?/g, '&')
    .replace(/&#x26;?/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?34;?/g, '"')
    .replace(/&#x22;?/gi, '"')
    .replace(/&apos;|&#0?39;?/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  // Protocol relative
  if (value.startsWith('//')) value = 'https:' + value;
  return value.trim();
}

/** Strip tags/entities and collapse whitespace, for anchor text based titles. */
export function textOf(fragment: string): string {
  return decodeCandidate(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag)) !== null) {
    const key = match[1].toLowerCase();
    attributes[key] = decodeCandidate(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/** `07 - The Harbor.mp4` -> a title; `ep-0003.mp4` -> order hint 3. */
export function titleFromUrl(url: string, fallback = ''): string {
  let name = url;
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    name = url.split('?')[0].split('/').filter(Boolean).pop() ?? url;
  }
  name = name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_.+]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return fallback;
  // Keep a leading episode number readable, prettify the rest.
  return name
    .replace(/\b(e|ep|episode|s\d{2}e\d{2}|part|ch|chapter)\b\.?\s*/i, (matched) =>
      /^s\d{2}e\d{2}$/i.test(matched.trim().replace(/[.\s]$/, '')) ? matched.trim().replace(/[.\s]$/, '') + ' ' : '',
    )
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 200);
}

export function orderHintFromUrl(url: string): number | undefined {
  let name = url;
  try {
    name = decodeURIComponent(new URL(url).pathname);
  } catch {
    // keep
  }
  const explicit = /(?:episode|ep|e|part|ch|chapter|s\d{2}e)[._\-/\s]?(\d{1,4})/i.exec(name);
  if (explicit?.[1]) return Number.parseInt(explicit[1], 10);
  const leading = /(?:^|[/_\s])(\d{1,4})(?:[._\s-]|$)/.exec(name.split('?')[0]);
  if (leading?.[1]) return Number.parseInt(leading[1], 10);
  const query = /[?&](?:e|ep|episode|part|section)=(\d{1,4})\b/i.exec(url);
  if (query?.[1]) return Number.parseInt(query[1], 10);
  return undefined;
}

function pushUrl(
  target: Map<string, SniffedCandidate>,
  rawUrl: string | undefined,
  pageUrl: URL,
  options: {
    foundBy: FoundBy;
    depth: number;
    title?: string;
    posterUrl?: string;
    quality?: string;
    bitrateKbps?: number;
    width?: number;
    height?: number;
  },
  diagnostics: string[],
): void {
  if (!rawUrl) return;
  const decoded = decodeCandidate(rawUrl);
  if (!decoded || decoded.startsWith('data:') || decoded.startsWith('blob:') || decoded.startsWith('javascript:')) return;
  let url: URL;
  try {
    url = new URL(decoded, pageUrl);
  } catch {
    diagnostics.push(`skipped unparseable reference "${decoded.slice(0, 80)}"`);
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  const declaredType =
    url.searchParams.get('type') ?? url.searchParams.get('mime') ?? url.searchParams.get('format') ?? null;
  const format = resolveFormat(`${url.pathname}${url.search}`, declaredType);
  if (!format) return;
  url.hash = '';
  const key = url.toString();
  if (target.has(key)) {
    const existing = target.get(key)!;
    // A richer source (explicit tag/JSON) wins over the raw scan for metadata only.
    if (options.title && !existing.title) existing.title = options.title;
    if (options.posterUrl && !existing.posterUrl) existing.posterUrl = options.posterUrl;
    if (options.quality && existing.foundBy === 'raw-scan') existing.quality = options.quality;
    return;
  }
  target.set(key, {
    url: key,
    kind: format.kind,
    container: format.container,
    foundBy: options.foundBy,
    title: options.title ?? titleFromUrl(key),
    posterUrl: options.posterUrl,
    quality: options.quality ? normalizeQualityLabel(options.quality) : undefined,
    bitrateKbps: options.bitrateKbps,
    width: options.width,
    height: options.height,
    pageUrl: pageUrl.toString(),
    depth: options.depth,
    orderHint: orderHintFromUrl(key),
  });
}

/** Walk a parsed JSON value looking for media URLs (covers ld+json and API blobs). */
export function collectFromJson(value: unknown, context: { title?: string; quality?: string; posterUrl?: string } = {}): Array<{ url: string; title?: string; quality?: string; bitrateKbps?: number; width?: number; height?: number; posterUrl?: string }> {
  const found: Array<{ url: string; title?: string; quality?: string; bitrateKbps?: number; width?: number; height?: number; posterUrl?: string }> = [];
  const seen = new Set<string>();

  const visit = (node: unknown, inherited: { title?: string; quality?: string; posterUrl?: string }, depth: number): void => {
    if (depth > 12 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      const format = resolveFormat(node);
      if (format) found.push({ url: decodeCandidate(node), title: inherited.title, quality: inherited.quality });
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, inherited, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const title =
      (typeof record.title === 'string' && record.title) ||
      (typeof record.name === 'string' && record.name) ||
      (typeof record.label === 'string' && /^\s*\d{3,4}p?\s*$/.test(record.label) ? undefined : record.label) ||
      inherited.title;
    const rawQuality = record.quality ?? record.resolution ?? record.height ?? record.definition ?? record.label;
    const quality =
      typeof rawQuality === 'number' ? `${rawQuality}p` : typeof rawQuality === 'string' ? rawQuality : inherited.quality;
    const posterUrl =
      typeof record.thumbnailUrl === 'string'
        ? record.thumbnailUrl
        : typeof record.thumbnail === 'string'
          ? record.thumbnail
          : typeof record.poster === 'string'
            ? record.poster
            : typeof record.image === 'string'
              ? record.image
              : inherited.posterUrl;
    const nested = {
      title: typeof title === 'string' ? title : undefined,
      quality,
      posterUrl: typeof posterUrl === 'string' ? posterUrl : undefined,
    };

    for (const [key, entry] of Object.entries(record)) {
      const lowerKey = key.toLowerCase();
      const isMediaKey =
        ['contenturl', 'content_url', 'videourl', 'video_url', 'streamurl', 'stream_url', 'playbackurl', 'playback_url', 'hls', 'mp4', 'webm', 'dash', 'url', 'src', 'source', 'file', 'link', 'embedurl', 'embed_url'].includes(lowerKey);
      if (typeof entry === 'string') {
        const format = resolveFormat(entry);
        if (format && isMediaKey) {
          const candidate = {
            url: decodeCandidate(entry),
            title: nested.title ?? (typeof record.name === 'string' ? record.name : undefined),
            quality: nested.quality,
            bitrateKbps:
              toNumber(record.bitrate) ?? (record.bandwidth ? Math.round(toNumber(record.bandwidth)! / 1000) : undefined),
            width: toNumber(record.width),
            height: toNumber(record.height),
            posterUrl: nested.posterUrl,
          };
          const dedupe = candidate.url + '|' + (candidate.quality ?? '');
          if (!seen.has(dedupe)) {
            seen.add(dedupe);
            found.push(candidate);
          }
        } else if (format) {
          visit(entry, nested, depth + 1);
        }
        continue;
      }
      visit(entry, nested, depth + 1);
    }
  };

  visit(value, context, 0);
  return found.filter((entry) => entry.url && !seenUrl(entry.url, found, entry));
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** A rendition name like `1080p`, `HD`, `4K` - a quality, not the title of the video. */
export function isQualityLikeLabel(value: string | undefined): boolean {
  if (!value) return false;
  return /^\s*(?:[0-9]{3,4}\s*p(?:ixel)?s?|sd|hd|fhd|uhd|4k|8k|source|original|auto|adaptive)\s*$/i.test(value);
}

/** Drop a bare URL duplicate when the same URL also appears with a quality label. */
function seenUrl(url: string, all: Array<{ url: string; quality?: string }>, self: { url: string; quality?: string }): boolean {
  if (self.quality) return false;
  return all.some((entry) => entry.url === url && entry.quality);
}

const VIDEO_TAG = /<video\b([^>]*)>([\s\S]*?)<\/video\s*>|<video\b([^>]*)\/?>/gi;
const SOURCE_TAG = /<source\b([^>]*)>/gi;
const IFRAME_TAG = /<(?:iframe|embed|object)\b([^>]*)>/gi;
const ANCHOR_TAG = /<a\b([^>]*)>([\s\S]{0,400}?)<\/a\s*>/gi;
const META_TAG = /<meta\b([^>]*)>/gi;
const LINK_TAG = /<link\b([^>]*)>/gi;
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]{0,400000}?)<\/script\s*>/gi;
const QUALITY_KEY = /\b(?:label|title|quality|resolution|height|res|name)\s*[:=]\s*"?([0-9]{3,4}p?|HD|SD|FHD|4K|auto)"?/i;

/**
 * Scan one document. `depth` guards the embed/crawl recursion.
 */
export function sniffDocument(html: string, pageUrl: URL, options: { depth?: number; maxCandidates?: number } = {}): SniffResult {
  const depth = options.depth ?? 0;
  const maxCandidates = options.maxCandidates ?? 120;
  const candidates = new Map<string, SniffedCandidate>();
  const embeds: string[] = [];
  const episodeLinks: string[] = [];
  const diagnostics: string[] = [];
  let pageTitle: string | undefined;
  let pageImage: string | undefined;
  let pageDescription: string | undefined;

  const add = (rawUrl: string | undefined, foundBy: FoundBy, extra: Partial<SniffedCandidate> = {}) => {
    if (candidates.size >= maxCandidates) return;
    pushUrl(candidates, rawUrl, pageUrl, { foundBy, depth, ...extra }, diagnostics);
  };

  // ---- document metadata ----------------------------------------------------
  const titleMatch = /<title[^>]*>([\s\S]{0,500}?)<\/title\s*>/i.exec(html);
  if (titleMatch) pageTitle = textOf(titleMatch[1]).slice(0, 300) || undefined;

  for (const match of html.matchAll(META_TAG)) {
    const attributes = attributesOf(match[1]);
    const property = (attributes.property ?? attributes.name ?? attributes.itemprop ?? '').toLowerCase();
    const content = attributes.content ?? attributes['data-url'] ?? '';
    if (!content) continue;
    if (property === 'og:video' || property === 'og:video:url' || property === 'og:video:secure_url' || property === 'og:video:article') {
      add(content, 'meta', { title: pageTitle, posterUrl: pageImage });
    } else if (property === 'twitter:player:stream') {
      add(content, 'meta', { title: pageTitle });
    } else if (property === 'og:image' || property === 'twitter:image') {
      pageImage ??= decodeCandidate(content);
    } else if (property === 'og:title') {
      pageTitle ??= textOf(content);
    } else if (property === 'og:description' || property === 'description') {
      pageDescription ??= textOf(content).slice(0, 1000);
    }
  }

  for (const match of html.matchAll(LINK_TAG)) {
    const attributes = attributesOf(match[1]);
    const rel = (attributes.rel ?? '').toLowerCase();
    const as = (attributes.as ?? '').toLowerCase();
    const preload = rel.includes('alternate') || rel.includes('preload') || as === 'video' || as === 'audio';
    if (attributes.href && preload && resolveFormat(attributes.href)) add(attributes.href, 'link');
  }

  // ---- <video> / <source> --------------------------------------------------
  for (const match of html.matchAll(VIDEO_TAG)) {
    const openAttributes = attributesOf(match[1] ?? match[3] ?? '');
    const inner = match[2] ?? '';
    const title = openAttributes.title ?? openAttributes['data-title'] ?? openAttributes['aria-label'] ?? pageTitle;
    const poster = openAttributes.poster ? decodeCandidate(openAttributes.poster) : undefined;
    pageImage ??= poster;
    add(openAttributes.src, 'video-tag', { title, posterUrl: poster });
    for (const [key, value] of Object.entries(openAttributes)) {
      if (key.startsWith('data-')) add(value, 'data-attribute', { title, posterUrl: poster });
    }
    for (const sourceMatch of inner.matchAll(SOURCE_TAG)) {
      const sourceAttributes = attributesOf(sourceMatch[1]);
      add(sourceAttributes.src ?? sourceAttributes['data-src'], 'source-tag', {
        // `label="1080p"` names the rendition; using it as the title would call the
        // video "1080p", so only a descriptive label becomes a title.
        title: isQualityLikeLabel(sourceAttributes.label) ? title : (sourceAttributes.label ?? title),
        posterUrl: poster,
        quality: sourceAttributes.label ?? sourceAttributes.type,
      });
      for (const [key, value] of Object.entries(sourceAttributes)) {
        if (key.startsWith('data-')) add(value, 'data-attribute', { title });
      }
    }
    if (inner) {
      // Fallback for `<video>` payloads where the URLs only live in a JS blob inside.
      for (const urlMatch of inner.matchAll(MEDIA_URL_PATTERN)) add(urlMatch[0], 'raw-scan', { title });
    }
  }

  // ---- standalone <source> / data- attributes anywhere ---------------------
  for (const match of html.matchAll(SOURCE_TAG)) {
    const sourceAttributes = attributesOf(match[1]);
    add(sourceAttributes.src ?? sourceAttributes['data-src'], 'source-tag', {
      quality: sourceAttributes.label ?? sourceAttributes.type,
    });
  }
  for (const match of html.matchAll(DATA_ATTRIBUTE_PATTERN)) {
    const value = match[2] ?? match[3];
    if (value && (value.includes(',') || value.includes('|'))) {
      for (const part of value.split(/[,|]/)) add(part, 'data-attribute');
    } else {
      add(value, 'data-attribute');
    }
  }

  // ---- iframes / embeds / anchors ------------------------------------------
  for (const match of html.matchAll(IFRAME_TAG)) {
    const attributes = attributesOf(match[1]);
    const src = attributes.src ?? attributes['data-src'] ?? attributes.data ?? attributes['data-orig-src'];
    if (!src) continue;
    if (resolveFormat(src)) add(src, 'iframe');
    else if (depth < 1) embeds.push(decodeCandidate(src));
  }

  for (const match of html.matchAll(ANCHOR_TAG)) {
    const attributes = attributesOf(match[1]);
    const href = attributes.href;
    if (!href) continue;
    const label = textOf(match[2] ?? '') || undefined;
    if (resolveFormat(href)) {
      add(href, 'anchor', { title: label });
    } else if (attributes.href && isEpisodeLink(href, pageUrl)) {
      episodeLinks.push(decodeCandidate(href));
    }
  }

  // ---- inline scripts: player configs and JSON blobs ----------------------
  const scriptTags = [...html.matchAll(SCRIPT_BLOCK)];
  for (const match of scriptTags) {
    const attributes = attributesOf(match[1] ?? '');
    const body = (match[2] ?? '').trim();
    if (!body) continue;
    const type = (attributes.type ?? '').toLowerCase();

    if (type.includes('ld+json')) {
      for (const block of body.split(/\n\s*(?=\{|\[)/)) {
        try {
          const parsed: unknown = JSON.parse(block);
          for (const entry of collectFromJson(parsed, { title: pageTitle })) {
            add(entry.url, 'json-ld', {
              title: entry.title,
              quality: entry.quality,
              bitrateKbps: entry.bitrateKbps,
              width: entry.width,
              height: entry.height,
              posterUrl: entry.posterUrl,
            });
          }
        } catch {
          // Not valid JSON: fall through to the text scan below.
          for (const urlMatch of block.matchAll(MEDIA_URL_PATTERN)) add(urlMatch[0], 'raw-scan');
        }
      }
      continue;
    }

    // `{file:"a.mp4", label:"1080p"}` / `{src:"a.m3u8", res:"1920x1080", bandwidth:5200000}`
    for (const literal of body.matchAll(/\{[^{}]{0,2000}?\}/g)) {
      // Player configs are usually JSON *inside* a JS string literal, so slashes and
      // quotes arrive escaped (`"file":"\/media\/hd.mp4"`). Unescape before matching,
      // otherwise every JS-embedded source is invisible to the sniffer.
      const text = literal[0].replace(/\\(['"\\/])/g, '$1');
      const url = LITERAL_KEYED_URL.exec(text)?.[1] ?? LITERAL_MEDIA_URL.exec(text)?.[1];
      if (!url) continue;
      const qualityMatch = QUALITY_KEY.exec(text);
      const bandwidth = /\b(?:bandwidth|bitrate|bps)\s*[:=]\s*"?(\d{4,9})"?/i.exec(text);
      const resolution = /(?:res|resolution|size|dimension)?\s*[:=]?\s*"?(\d{3,4})\s*[x*]\s*(\d{3,4})/i.exec(text);
      const rawBitrate = bandwidth?.[1] ? Number.parseInt(bandwidth[1], 10) : undefined;
      add(url, 'player-config', {
        title: /["'](?:title|name)["']\s*:\s*["']([^"']{3,140})["']/i.exec(text)?.[1],
        quality: qualityMatch?.[1],
        // Values above ~20k are bps, smaller ones are already kbps.
        bitrateKbps: rawBitrate === undefined ? undefined : rawBitrate > 20_000 ? Math.round(rawBitrate / 1000) : rawBitrate,
        width: resolution ? Number.parseInt(resolution[1], 10) : undefined,
        height: resolution ? Number.parseInt(resolution[2], 10) : undefined,
      });
    }

    // Any remaining URL string inside the script body.
    for (const urlMatch of body.matchAll(MEDIA_URL_PATTERN)) add(urlMatch[0], 'raw-scan');
  }

  // ---- last resort: the whole document ------------------------------------
  for (const match of html.matchAll(MEDIA_URL_PATTERN)) add(match[0], 'raw-scan');

  return {
    candidates: [...candidates.values()],
    embeds: unique(embeds).slice(0, 12),
    episodeLinks: unique(episodeLinks).slice(0, 120),
    pageTitle,
    pageImage,
    pageDescription,
    diagnostics: unique(diagnostics).slice(0, 40),
  };
}

/**
 * Merge duplicates of the same media URL, keeping the richest finding.
 * Explicit markup beats a raw text scan, and a shallower document beats a deeper one.
 */
export function dedupeCandidates(candidates: SniffedCandidate[]): SniffedCandidate[] {
  const priority: Partial<Record<FoundBy, number>> = {
    'video-tag': 0,
    'source-tag': 1,
    manifest: 2,
    meta: 3,
    'player-config': 4,
    'json-ld': 5,
    anchor: 6,
    link: 7,
    'data-attribute': 8,
    'raw-scan': 9,
  };
  const byUrl = new Map<string, SniffedCandidate>();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url);
    if (!existing) {
      byUrl.set(candidate.url, candidate);
      continue;
    }
    existing.title ??= candidate.title;
    existing.posterUrl ??= candidate.posterUrl;
    existing.quality ??= candidate.quality;
    existing.bitrateKbps ??= candidate.bitrateKbps;
    existing.width ??= candidate.width;
    existing.height ??= candidate.height;
    existing.orderHint ??= candidate.orderHint;
    if ((priority[candidate.foundBy] ?? 9) < (priority[existing.foundBy] ?? 9)) {
      byUrl.set(candidate.url, { ...candidate, title: candidate.title ?? existing.title, posterUrl: candidate.posterUrl ?? existing.posterUrl });
    }
  }
  return [...byUrl.values()].sort(
    (a, b) => (priority[a.foundBy] ?? 9) - (priority[b.foundBy] ?? 9) || a.depth - b.depth || (a.orderHint ?? 1e9) - (b.orderHint ?? 1e9),
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Heuristic: does this link look like "episode 4 of a series" on the same site? */
export function isEpisodeLink(href: string, pageUrl: URL): boolean {
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return false;
  }
  if (url.origin !== pageUrl.origin) return false;
  if (resolveFormat(url.pathname)) return false;
  const haystack = `${url.pathname}${url.search}`;
  if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|ico|pdf|zip|json)\b/i.test(haystack)) return false;
  if (/\/(?:login|signup|register|share|report|contact|about|terms|privacy|policy|ads)(?:\/|$)/i.test(haystack)) return false;
  return EPISODE_LINK_PATTERN.test(haystack);
}
