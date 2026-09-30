/**
 * TikTok link analysis, pure functions only (no network, no Worker APIs).
 *
 * Flow implemented on top of these helpers by `providers/extract/tiktok.ts`:
 *
 *   paste URL -> resolve short URL -> read the PUBLIC page (or public oEmbed)
 *     -> decide: mini-drama or normal video -> title + episode number
 *     -> episode list -> show it in the tool
 *
 * Everything here works on what a logged-out visitor already receives: the JSON blob
 * the public page embeds for its own player (`__UNIVERSAL_DATA_FOR_REHYDRATION__`),
 * the Open Graph tags, and the public oEmbed response. There is no signing, no
 * cookies, no bot-wall bypass and no media URL extraction. TikTok's page shape is
 * not a stable contract, so every reader is defensive and the result always carries
 * the `signals` that led to the verdict, so the UI can show *why* and never pretends
 * to be more certain than it is.
 */

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function isTikTokHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'tiktok.com' || host.endsWith('.tiktok.com');
}

/** `vm.tiktok.com/ZM…`, `vt.tiktok.com/ZS…`, `www.tiktok.com/t/ZT…`, `m.tiktok.com/v/…`. */
export function isShortTikTokUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return true;
  return /^\/(?:t|v)\/[\w-]+\/?$/.test(url.pathname) && isTikTokHost(host);
}

export interface TikTokUrlParts {
  videoId?: string;
  username?: string;
  /** `video`, `photo`, `playlist`, `profile` or `unknown`. */
  kind: 'video' | 'photo' | 'playlist' | 'profile' | 'unknown';
}

export function parseTikTokUrl(url: URL): TikTokUrlParts {
  const path = url.pathname;
  const video = /^\/@([^/]+)\/(video|photo)\/(\d{6,25})/.exec(path);
  if (video) return { username: decodeURIComponent(video[1]), videoId: video[3], kind: video[2] as 'video' | 'photo' };
  const legacy = /^\/(?:v|embed(?:\/v2)?|player\/v1)\/(\d{6,25})/.exec(path);
  if (legacy) return { videoId: legacy[1], kind: 'video' };
  const playlist = /^\/@([^/]+)\/playlist\/[^/]*?-?(\d{6,25})/.exec(path);
  if (playlist) return { username: decodeURIComponent(playlist[1]), kind: 'playlist' };
  const profile = /^\/@([^/]+)\/?$/.exec(path);
  if (profile) return { username: decodeURIComponent(profile[1]), kind: 'profile' };
  return { kind: 'unknown' };
}

/** The share URL without tracking parameters: the same video, one stable spelling. */
export function canonicalVideoUrl(username: string | undefined, videoId: string): string {
  return username
    ? `https://www.tiktok.com/@${encodeURIComponent(username.replace(/^@/, ''))}/video/${videoId}`
    : `https://www.tiktok.com/@_/video/${videoId}`;
}

/** A video id / username recovered from HTML that names the video. */
export interface TikTokVideoRef {
  id: string;
  username?: string;
  url: string;
}

function linkCanonical(html: string): string | undefined {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim() || undefined;
  }
  return undefined;
}

function refFromUrl(raw: string | undefined): TikTokVideoRef | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!isTikTokHost(url.hostname)) return null;
  const parts = parseTikTokUrl(url);
  if ((parts.kind !== 'video' && parts.kind !== 'photo') || !parts.videoId) return null;
  return { id: parts.videoId, username: parts.username, url: canonicalVideoUrl(parts.username, parts.videoId) };
}

/**
 * Recover which video a page / embed snippet is about when the request URL alone does
 * not say so (short link that never redirected, oEmbed response, meta-tag fallback):
 * explicit canonical pointers first (og:url, al:web:url, rel=canonical, embed `cite`),
 * then embed attributes (`data-video-id`), then the first absolute TikTok video URL in
 * the text (short-link interstitials and the oEmbed `html` field carry the long URL in
 * JS strings / anchors).
 */
export function findVideoRefInHtml(html: string): TikTokVideoRef | null {
  if (!html) return null;
  for (const raw of [metaContent(html, 'og:url'), metaContent(html, 'al:web:url'), linkCanonical(html)]) {
    const ref = refFromUrl(raw);
    if (ref) return ref;
  }
  const cite = /cite\s*=\s*["']([^"']+)["']/i.exec(html);
  const cited = refFromUrl(cite?.[1] ? decodeEntities(cite[1]) : undefined);
  if (cited) return cited;
  const dataId = /data-video-id\s*=\s*["']?(\d{6,25})["'\s>]/i.exec(html);
  if (dataId?.[1]) {
    const username = /data-username\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
    return { id: dataId[1], username, url: canonicalVideoUrl(username, dataId[1]) };
  }
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    const found = refFromUrl(decodeEntities(match[0]));
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// text helpers: Khmer digits, hashtags, episode markers
// ---------------------------------------------------------------------------

const KHMER_DIGITS = '០១២៣៤៥៦៧៨៩';

/** `វគ្គ ១២` -> `វគ្គ 12` (also Thai / Arabic-Indic digits), so one regex set works. */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[០-៩]/g, (digit) => String(KHMER_DIGITS.indexOf(digit)))
    .replace(/[๐-๙]/g, (digit) => String(digit.charCodeAt(0) - 0x0e50))
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
}

export function hashtagsOf(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) tags.add(match[1].toLowerCase());
  return [...tags];
}

export interface EpisodeMarker {
  number: number;
  total?: number;
  /** The exact text that matched, e.g. `EP 12/60`. */
  text: string;
}

const LATIN_MARKER =
  /(?<![\p{L}\p{N}])(?:episodes?|episodio|episódio|epis[oó]dio|eps?|part[e]?|pt|chapter|capitulo|capítulo|ch|tập|tap|bagian|bahagian|bölüm|folge|épisode|odcinek|серия|часть)\.?\s*[:#.-]?\s*(\d{1,4})(?:\s*(?:\/|of|out of)\s*(\d{1,4}))?(?![\p{L}\p{N}])/iu;
const CJK_LIKE_MARKERS: RegExp[] = [
  /第\s*(\d{1,4})\s*[集话話章回]/u,
  /(\d{1,4})\s*[集话話]/u,
  /វគ្គ\s*(?:ទី)?\s*(\d{1,4})/u,
  /ភាគ\s*(?:ទី)?\s*(\d{1,4})/u,
  /ตอน(?:ที่)?\s*(\d{1,4})/u,
  /(?<![\p{L}\p{N}])#\s?(\d{1,3})(?![\p{L}\p{N}])/u,
];

/** Find the episode number in a caption / title / playlist item name. */
export function parseEpisodeMarker(text: string | undefined | null): EpisodeMarker | null {
  if (!text) return null;
  const normalized = normalizeDigits(text);
  const latin = LATIN_MARKER.exec(normalized);
  if (latin) {
    const number = Number.parseInt(latin[1], 10);
    const total = latin[2] ? Number.parseInt(latin[2], 10) : undefined;
    if (number > 0) return { number, total: total && total >= number ? total : undefined, text: latin[0].trim() };
  }
  for (const pattern of CJK_LIKE_MARKERS) {
    const match = pattern.exec(normalized);
    if (match) {
      const number = Number.parseInt(match[1], 10);
      if (number > 0) return { number, text: match[0].trim() };
    }
  }
  return null;
}

/** Caption -> a readable series/video title (no hashtags, mentions or episode marker). */
export function cleanTitle(text: string | undefined | null): string {
  if (!text) return '';
  let value = normalizeDigits(text)
    .replace(/#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/@[\w.]+/g, ' ');
  const marker = parseEpisodeMarker(value);
  if (marker) value = value.replace(marker.text, ' ');
  value = value
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|.,!?·•()[\]]+|[\s\-–—:|.,!?·•([\]]+$/g, '')
    .trim();
  return value;
}

// ---------------------------------------------------------------------------
// page data
// ---------------------------------------------------------------------------

export interface TikTokPlaylistRef {
  id?: string;
  name?: string;
  /** Total number of videos TikTok says the playlist has. */
  total?: number;
  items: Array<{ id: string; title?: string; username?: string; durationSeconds?: number; cover?: string }>;
  /** Field name the playlist was read from, shown as a signal. */
  source: string;
}

export interface TikTokVideoInfo {
  id?: string;
  caption: string;
  username?: string;
  nickname?: string;
  durationSeconds?: number;
  cover?: string;
  createdAt?: string;
  hashtags: string[];
  playlist?: TikTokPlaylistRef;
  /** A field that explicitly labels the post as a drama / series (strongest signal). */
  dramaField?: string;
  /** Where the data came from: embedded page JSON, meta tags or oEmbed. */
  origin: 'page-json' | 'meta' | 'oembed';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function int(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)));
}

export function metaContent(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${escaped}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeEntities(match[1]).trim() || undefined;
  }
  return undefined;
}

/** Parse the JSON blob TikTok embeds in its public page, if present. */
export function readEmbeddedJson(html: string): Record<string, unknown> | null {
  for (const id of ['__UNIVERSAL_DATA_FOR_REHYDRATION__', 'SIGI_STATE']) {
    const match = new RegExp(`<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, 'i').exec(html);
    if (!match) continue;
    try {
      const parsed = asRecord(JSON.parse(match[1]));
      if (parsed) return parsed;
    } catch {
      // A truncated or changed blob is just "no embedded data".
    }
  }
  return null;
}

/** The `itemStruct` of the video detail scope (new layout) or `ItemModule` (old layout). */
function findItemStruct(root: Record<string, unknown>, wantedId?: string): Record<string, unknown> | null {
  const scope = asRecord(root.__DEFAULT_SCOPE__);
  if (scope) {
    for (const [key, value] of Object.entries(scope)) {
      if (!/video-detail/i.test(key)) continue;
      const struct = asRecord(asRecord(asRecord(value)?.itemInfo)?.itemStruct);
      if (struct) return struct;
    }
  }
  const module = asRecord(root.ItemModule);
  if (module) {
    if (wantedId && asRecord(module[wantedId])) return asRecord(module[wantedId]);
    const first = Object.values(module).map(asRecord).find(Boolean);
    if (first) return first;
  }
  return null;
}

const PLAYLIST_KEY = /^(?:playlist|playlistinfo|mix|mixinfo|collection|collectioninfo|series|seriesinfo|drama|dramainfo|miniseries)$/i;
const DRAMA_KEY = /drama|miniseries|shortplay|short_play/i;

function readItemRef(value: unknown): TikTokPlaylistRef['items'][number] | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const id = String(value);
    return /^\d{6,25}$/.test(id) ? { id } : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const id = str(record.id) ?? str(record.itemId) ?? str(record.videoId) ?? str(record.aweme_id);
  if (!id || !/^\d{6,25}$/.test(id)) return null;
  const author = asRecord(record.author);
  const video = asRecord(record.video);
  return {
    id,
    title: str(record.desc) ?? str(record.title) ?? str(record.name),
    username: str(author?.uniqueId) ?? str(record.authorName) ?? (typeof record.author === 'string' ? record.author : undefined),
    durationSeconds: int(video?.duration) ?? int(record.duration),
    cover: str(video?.cover) ?? str(record.cover),
  };
}

const ITEM_ARRAY_KEYS = ['itemList', 'items', 'videoList', 'videos', 'videoIds', 'itemIds', 'episodes', 'episodeList', 'playlist_video_ids', 'list'];

function readPlaylist(value: unknown, source: string): TikTokPlaylistRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const items: TikTokPlaylistRef['items'] = [];
  const seen = new Set<string>();
  for (const key of ITEM_ARRAY_KEYS) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const ref = readItemRef(entry);
      if (ref && !seen.has(ref.id)) {
        seen.add(ref.id);
        items.push(ref);
      }
    }
  }
  const id = str(record.id) ?? str(record.playlistId) ?? str(record.mixId) ?? str(record.collectionId) ?? str(record.seriesId);
  const name = str(record.name) ?? str(record.title) ?? str(record.mixName) ?? str(record.playlistName) ?? str(record.seriesName);
  const total =
    int(record.videoCount) ?? int(record.itemCount) ?? int(record.total) ?? int(record.episodeCount) ??
    int(record.playlist_item_total) ?? int(record.count);
  if (!id && !name && items.length === 0 && total === undefined) return null;
  return { id, name, total, items, source };
}

/** Look for a playlist / series / drama object next to (or inside) the video. */
function findPlaylist(root: Record<string, unknown>, item: Record<string, unknown> | null): { playlist?: TikTokPlaylistRef; dramaField?: string } {
  let dramaField: string | undefined;
  const candidates: Array<[string, unknown]> = [];
  if (item) {
    for (const [key, value] of Object.entries(item)) {
      if (PLAYLIST_KEY.test(key) && asRecord(value)) candidates.push([`itemStruct.${key}`, value]);
      if (DRAMA_KEY.test(key) && value) dramaField ??= `itemStruct.${key}`;
    }
  }
  const scope = asRecord(root.__DEFAULT_SCOPE__);
  if (scope) {
    for (const [scopeKey, scopeValue] of Object.entries(scope)) {
      if (!/playlist|mix|collection|series|drama/i.test(scopeKey)) continue;
      if (DRAMA_KEY.test(scopeKey)) dramaField ??= `scope.${scopeKey}`;
      const record = asRecord(scopeValue);
      if (!record) continue;
      candidates.push([`scope.${scopeKey}`, record]);
      for (const [key, inner] of Object.entries(record)) {
        if (asRecord(inner) && /playlist|mix|collection|series|drama/i.test(key)) candidates.push([`scope.${scopeKey}.${key}`, inner]);
      }
    }
  }
  for (const [source, value] of candidates) {
    const playlist = readPlaylist(value, source);
    if (playlist) return { playlist, dramaField };
  }
  // Only a bare id on the item ("playlistId": "…"): we know there is a playlist, not its contents.
  const bareId = item ? str(item.playlistId) ?? str(item.collectionId) ?? str(item.mixId) : undefined;
  if (bareId) return { playlist: { id: bareId, items: [], source: 'itemStruct.playlistId' }, dramaField };
  return { dramaField };
}

function isoFromCreateTime(value: unknown): string | undefined {
  const seconds = int(value);
  if (!seconds || seconds < 1_000_000_000) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/** Read everything useful out of the public HTML of a video page. */
export function parseVideoPage(html: string, pageUrl: URL): TikTokVideoInfo | null {
  const urlParts = parseTikTokUrl(pageUrl);
  const root = readEmbeddedJson(html);
  const item = root ? findItemStruct(root, urlParts.videoId) : null;

  if (root && item) {
    const author = asRecord(item.author);
    const video = asRecord(item.video);
    const caption = str(item.desc) ?? '';
    const tags = new Set(hashtagsOf(caption));
    if (Array.isArray(item.textExtra)) {
      for (const extra of item.textExtra) {
        const name = str(asRecord(extra)?.hashtagName);
        if (name) tags.add(name.toLowerCase());
      }
    }
    if (Array.isArray(item.challenges)) {
      for (const challenge of item.challenges) {
        const name = str(asRecord(challenge)?.title);
        if (name) tags.add(name.toLowerCase());
      }
    }
    const { playlist, dramaField } = findPlaylist(root, item);
    return {
      id: str(item.id) ?? urlParts.videoId,
      caption,
      username: str(author?.uniqueId) ?? (typeof item.author === 'string' ? item.author : undefined) ?? urlParts.username,
      nickname: str(author?.nickname),
      durationSeconds: int(video?.duration),
      cover: str(video?.cover) ?? str(video?.originCover),
      createdAt: isoFromCreateTime(item.createTime),
      hashtags: [...tags],
      playlist,
      dramaField,
      origin: 'page-json',
    };
  }

  const caption = metaContent(html, 'og:description') ?? metaContent(html, 'description') ?? metaContent(html, 'og:title');
  if (caption) {
    // The request URL may be a short link that never redirected; the page's own
    // canonical pointers usually still name the video.
    const ref = urlParts.videoId ? null : findVideoRefInHtml(html);
    return {
      id: urlParts.videoId ?? ref?.id,
      caption,
      username: urlParts.username ?? ref?.username,
      hashtags: hashtagsOf(caption),
      cover: metaContent(html, 'og:image'),
      origin: 'meta',
    };
  }
  return null;
}

/** Public oEmbed (`https://www.tiktok.com/oembed?url=…`): title, author, thumbnail. */
export function parseOEmbed(json: unknown, pageUrl: URL): TikTokVideoInfo | null {
  const record = asRecord(json);
  if (!record) return null;
  const caption = str(record.title) ?? '';
  const authorUrl = str(record.author_url);
  const parts = parseTikTokUrl(pageUrl);
  // TikTok's response carries no id field of its own; the embed snippet in `html`
  // names the video (`data-video-id`, `cite`, anchors) even when `url` was a short
  // link the tool could not redirect-resolve.
  const refs = findVideoRefInHtml(str(record.html) ?? '');
  const username =
    str(record.author_unique_id) ?? (authorUrl ? /@([^/?#]+)/.exec(authorUrl)?.[1] : undefined) ?? refs?.username ?? parts.username;
  if (!caption && !username) return null;
  return {
    id: str(record.embed_product_id) ?? refs?.id ?? parts.videoId,
    caption,
    username,
    nickname: str(record.author_name),
    cover: str(record.thumbnail_url),
    hashtags: hashtagsOf(caption),
    origin: 'oembed',
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

export type ContentKind = 'mini-drama' | 'normal-video';
export type Confidence = 'high' | 'medium' | 'low';

export interface Classification {
  kind: ContentKind;
  confidence: Confidence;
  score: number;
  /** Human readable reasons, always shown to the user. */
  signals: string[];
}

/** Hashtags / app names that short-drama posts use to label themselves. */
export const DRAMA_TAGS = new Set([
  'minidrama', 'minidramas', 'mini-drama', 'microdrama', 'shortdrama', 'shortdramas', 'dramashort',
  'dramaseries', 'miniseries', 'shortplay', 'reeldrama', 'dramabox', 'shortmax', 'flextv',
  'goodshort', 'netshort', 'dramawave', 'reelshort', 'moboreels', 'tiktokminis', 'minidramaseries',
  'ละครสั้น', 'phimngan', 'dramapendek', 'dramacina', 'drama', 'ភាពយន្តខ្លី',
]);

export function classify(info: TikTokVideoInfo): Classification {
  const signals: string[] = [];
  let score = 0;
  let strong = false;

  if (info.dramaField) {
    score += 3;
    strong = true;
    signals.push(`page labels it as a drama/series (${info.dramaField})`);
  }
  const tags = info.hashtags.filter((tag) => DRAMA_TAGS.has(tag));
  if (tags.length > 0) {
    // A lone generic "#drama" is weak evidence: only specific tags count double.
    const specific = tags.some((tag) => tag !== 'drama');
    score += specific ? 2 : 1;
    signals.push(`drama hashtag: ${tags.map((tag) => `#${tag}`).join(' ')}`);
  }
  const marker = parseEpisodeMarker(info.caption);
  if (marker) {
    score += 1;
    signals.push(`caption has an episode marker ("${marker.text}")`);
  }
  if (info.playlist) {
    score += 1;
    const count = Math.max(info.playlist.total ?? 0, info.playlist.items.length);
    signals.push(`video belongs to a playlist${info.playlist.name ? ` "${info.playlist.name}"` : ''}${count > 0 ? ` (${count} videos)` : ''}`);
    if (count >= 3) score += 1;
    if (parseEpisodeMarker(info.playlist.name)) {
      score += 1;
      signals.push('playlist name contains an episode marker');
    }
  }

  const isDrama = strong || score >= 3 || (score >= 2 && tags.some((tag) => tag !== 'drama'));
  if (isDrama) {
    return { kind: 'mini-drama', confidence: score >= 4 || strong ? 'high' : 'medium', score, signals };
  }
  if (signals.length === 0) signals.push('no series, playlist, drama hashtag or episode marker found');
  return { kind: 'normal-video', confidence: score === 0 ? 'high' : 'low', score, signals };
}

// ---------------------------------------------------------------------------
// episode list
// ---------------------------------------------------------------------------

export interface TikTokEpisode {
  /** 1-based position in the list (the tool's stable index). */
  index: number;
  /** The number the creator gave it ("EP 12"), when one could be read. */
  episodeNumber?: number;
  videoId: string;
  title: string;
  url: string;
  durationSeconds?: number;
  cover?: string;
  current: boolean;
}

export interface TikTokAnalysis {
  kind: ContentKind;
  classification: Classification;
  title: string;
  videoId?: string;
  username?: string;
  currentEpisodeNumber?: number;
  totalEpisodes?: number;
  episodes: TikTokEpisode[];
  /** Whether `episodes` is believed to be the whole series. */
  listComplete: boolean;
  listNote?: string;
}

export function analyzeVideo(info: TikTokVideoInfo, fallbackUsername?: string): TikTokAnalysis {
  const classification = classify(info);
  const username = info.username ?? fallbackUsername;
  const marker = parseEpisodeMarker(info.caption);
  const videoId = info.id;

  const currentTitleBase = cleanTitle(info.caption);

  if (classification.kind === 'normal-video') {
    const title = currentTitleBase || (username ? `@${username} video ${videoId ?? ''}`.trim() : `TikTok video ${videoId ?? ''}`.trim());
    const episodes: TikTokEpisode[] = videoId
      ? [{
          index: 1,
          videoId,
          title,
          url: canonicalVideoUrl(username, videoId),
          durationSeconds: info.durationSeconds,
          cover: info.cover,
          current: true,
        }]
      : [];
    return { kind: 'normal-video', classification, title, videoId, username, episodes, listComplete: true };
  }

  // ---- mini-drama ---------------------------------------------------------
  const playlist = info.playlist;
  const seriesTitle =
    cleanTitle(playlist?.name) || currentTitleBase || (username ? `@${username} mini-drama` : 'TikTok mini-drama');
  const total = Math.max(playlist?.total ?? 0, playlist?.items.length ?? 0, marker?.total ?? 0) || undefined;

  const drafts: Array<Omit<TikTokEpisode, 'index'>> = [];
  const seen = new Set<string>();
  for (const item of playlist?.items ?? []) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const itemMarker = parseEpisodeMarker(item.title);
    const isCurrent = item.id === videoId;
    const number = itemMarker?.number ?? (isCurrent ? marker?.number : undefined);
    drafts.push({
      episodeNumber: number,
      videoId: item.id,
      title: cleanTitle(item.title) || (isCurrent ? currentTitleBase : '') || seriesTitle,
      url: canonicalVideoUrl(item.username ?? username, item.id),
      durationSeconds: item.durationSeconds ?? (isCurrent ? info.durationSeconds : undefined),
      cover: item.cover ?? (isCurrent ? info.cover : undefined),
      current: isCurrent,
    });
  }
  if (videoId && !seen.has(videoId)) {
    drafts.push({
      episodeNumber: marker?.number,
      videoId,
      title: currentTitleBase || seriesTitle,
      url: canonicalVideoUrl(username, videoId),
      durationSeconds: info.durationSeconds,
      cover: info.cover,
      current: true,
    });
  }

  // Order by the creator's own numbers when every entry has one, else keep TikTok's order.
  const allNumbered = drafts.length > 0 && drafts.every((draft) => draft.episodeNumber !== undefined) &&
    new Set(drafts.map((draft) => draft.episodeNumber)).size === drafts.length;
  if (allNumbered) drafts.sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));

  const episodes: TikTokEpisode[] = drafts.map((draft, position) => ({
    ...draft,
    index: position + 1,
    // Playlist order is the episode order when TikTok gave no explicit numbers.
    episodeNumber: draft.episodeNumber ?? (playlist && playlist.items.length > 0 && !allNumbered ? position + 1 : undefined),
  }));

  const listComplete = episodes.length > 1 && (total === undefined || episodes.length >= total);
  let listNote: string | undefined;
  if (!listComplete) {
    listNote = episodes.length <= 1
      ? 'The public page only exposes this one episode. The full episode list needs an authorized source (set SOURCE_API_BASE_URL / SOURCE_ALLOWED_HOSTS to a catalog you are allowed to call).'
      : `The public page lists ${episodes.length} of ${total} episodes.`;
  }

  return {
    kind: 'mini-drama',
    classification,
    title: seriesTitle,
    videoId,
    username,
    currentEpisodeNumber: marker?.number,
    totalEpisodes: total,
    episodes,
    listComplete,
    listNote,
  };
}
