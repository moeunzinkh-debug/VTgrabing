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
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') return true;
  if (!isTikTokHost(host)) return false;
  const match = /^\/(t|v)\/([\w-]+)\/?$/.exec(url.pathname);
  if (!match) return false;
  // `/v/<digits>` is the legacy long form: the number already is the video id, not a code.
  return !(match[1] === 'v' && /^\d{6,25}$/.test(match[2]));
}

export interface TikTokUrlParts {
  videoId?: string;
  username?: string;
  /** The playlist / collection id, when the link names one. */
  playlistId?: string;
  /** `video`, `photo`, `playlist` (also collections), `profile` or `unknown`. */
  kind: 'video' | 'photo' | 'playlist' | 'profile' | 'unknown';
}

/** A malformed `%` escape must not turn a pasted link into an exception. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// TikTok sometimes puts a locale in front of the path (`/en/@user/video/…`).
const LOCALE = '(?:/[a-z]{2}(?:-[a-zA-Z]{2,4})?)?';
const VIDEO_PATH = new RegExp(`^${LOCALE}/@([^/]*)/(video|photo)/(\\d{6,25})`);
const LEGACY_VIDEO_PATH = new RegExp(`^${LOCALE}/(?:v|embed(?:/v2)?|player/v1|share/video)/(\\d{6,25})`);
// `/playlist/<name>-<id>` is the older spelling, `/collection/<name>-<id>` the current one.
const PLAYLIST_PATH = new RegExp(`^${LOCALE}/@([^/]+)/(?:playlist|collection|series|mix)/([^/?#]+)`);
const PROFILE_PATH = new RegExp(`^${LOCALE}/@([^/]+)/?$`);

export function parseTikTokUrl(url: URL): TikTokUrlParts {
  const path = url.pathname;
  const video = VIDEO_PATH.exec(path);
  if (video) {
    return {
      username: video[1] ? safeDecode(video[1]) : undefined,
      videoId: video[3],
      kind: video[2] as 'video' | 'photo',
    };
  }
  const legacy = LEGACY_VIDEO_PATH.exec(path);
  if (legacy) return { videoId: legacy[1], kind: 'video' };
  const playlist = PLAYLIST_PATH.exec(path);
  if (playlist) {
    const id = /(?:^|-)(\d{6,25})$/.exec(safeDecode(playlist[2]))?.[1];
    return { username: safeDecode(playlist[1]), playlistId: id, kind: 'playlist' };
  }
  const profile = PROFILE_PATH.exec(path);
  if (profile) return { username: safeDecode(profile[1]), kind: 'profile' };
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

/** `<meta http-equiv="refresh" content="0; url=…">`: the plainest interstitial redirect. */
function metaRefreshTarget(html: string): string | undefined {
  const match = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url\s*=\s*['"]?([^"'>\s]+)/i.exec(html);
  return match?.[1] ? decodeEntities(match[1]).trim() || undefined : undefined;
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
 * A login / consent redirect keeps the page the visitor wanted in a query parameter
 * (`/login?redirect_url=https%3A%2F%2Fwww.tiktok.com%2F%40a%2Fvideo%2F123`).
 */
export function findVideoRefInUrl(url: URL): TikTokVideoRef | null {
  for (const key of ['redirect_url', 'redirectUrl', 'redirect', 'target', 'url', 'next']) {
    const ref = refFromUrl(url.searchParams.get(key) ?? undefined);
    if (ref) return ref;
  }
  return null;
}

/** JSON-in-HTML writes slashes as `\/` or `\u002F`; undo that so URLs in script strings match. */
function unescapeJsonSlashes(text: string): string {
  return text.replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
}

export interface FindVideoRefOptions {
  /**
   * Also accept a video URL that is merely mentioned in the text, provided the text
   * names exactly one distinct video (default). A page that mentions several
   * (a feed, a "related videos" list, the home page) is never trusted to be about any
   * one of them, so `false` limits the search to explicit canonical pointers.
   */
  scanText?: boolean;
}

/**
 * Recover which video a page / embed snippet is about when the request URL alone does
 * not say so (short link that never redirected, oEmbed response, meta-tag fallback):
 * explicit canonical pointers first (og:url, al:web:url, rel=canonical, meta refresh,
 * embed `cite`), then embed attributes (`data-video-id`), then - only when the text
 * names a single video - a bare TikTok video URL (short-link interstitials and the
 * oEmbed `html` field carry the long URL in JS strings / anchors).
 */
export function findVideoRefInHtml(html: string, options: FindVideoRefOptions = {}): TikTokVideoRef | null {
  if (!html) return null;
  const text = unescapeJsonSlashes(html);
  for (const raw of [metaContent(text, 'og:url'), metaContent(text, 'al:web:url'), linkCanonical(text), metaRefreshTarget(text)]) {
    const ref = refFromUrl(raw);
    if (ref) return ref;
  }
  const cite = /cite\s*=\s*["']([^"']+)["']/i.exec(text);
  const cited = refFromUrl(cite?.[1] ? decodeEntities(cite[1]) : undefined);
  if (cited) return cited;
  const dataId = /data-video-id\s*=\s*["']?(\d{6,25})["'\s>]/i.exec(text);
  if (dataId?.[1]) {
    const username = /data-username\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
    return { id: dataId[1], username, url: canonicalVideoUrl(username, dataId[1]) };
  }
  if (options.scanText === false) return null;

  const named = new Map<string, TikTokVideoRef>();
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/g)) {
    const found = refFromUrl(decodeEntities(match[0]));
    if (!found) continue;
    const known = named.get(found.id);
    // The same video can be written with and without its username; keep the richer one.
    if (!known || (!known.username && found.username)) named.set(found.id, found);
    if (named.size > 1) return null;
  }
  return named.size === 1 ? [...named.values()][0] : null;
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
  /**
   * Where the data came from: embedded page JSON, meta tags, oEmbed, or `link` when
   * TikTok gave nothing and only the video id written in the URL is known.
   */
  origin: 'page-json' | 'meta' | 'oembed' | 'link';
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
  const found: TikTokPlaylistRef[] = [];
  for (const [source, value] of candidates) {
    const playlist = readPlaylist(value, source);
    if (playlist) found.push(playlist);
  }
  if (found.length > 0) {
    // The items, the id and the name may sit in different records of the same scope
    // (`itemList` beside a nested `collectionInfo`): take the fullest list, then fill
    // whatever it lacks from the others.
    const richest = found.reduce((best, next) => (next.items.length > best.items.length ? next : best));
    const playlist: TikTokPlaylistRef = {
      ...richest,
      id: richest.id ?? found.find((entry) => entry.id)?.id,
      name: richest.name ?? found.find((entry) => entry.name)?.name,
      total: richest.total ?? found.find((entry) => entry.total !== undefined)?.total,
    };
    return { playlist, dramaField };
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

/**
 * TikTok's stock tags for a page that is not about one video (home page, bot-check
 * and consent pages, removed videos). Used as a title they would be a lie.
 */
const GENERIC_TIKTOK_TEXT =
  /make your day|trends start here|watch and discover millions of personalized short videos|^\s*tiktok\s*$/i;

export function isGenericTikTokText(text: string | undefined | null): boolean {
  return !!text && GENERIC_TIKTOK_TEXT.test(text);
}

/** `statusCode` of the page's video-detail scope when it is not 0 (private, removed, blocked...). */
export interface VideoDetailStatus {
  code: number;
  message?: string;
}

function readVideoDetailStatus(root: Record<string, unknown>): VideoDetailStatus | null {
  const scope = asRecord(root.__DEFAULT_SCOPE__);
  if (!scope) return null;
  for (const [key, value] of Object.entries(scope)) {
    if (!/video-detail/i.test(key)) continue;
    const record = asRecord(value);
    const code = int(record?.statusCode);
    if (code !== undefined && code !== 0) return { code, message: str(record?.statusMsg) };
  }
  return null;
}

/** What one page told us, plus why it told us nothing when it did not. */
export interface VideoPageReading {
  info: TikTokVideoInfo | null;
  /** Set when TikTok itself says the video cannot be shown (so its tags are not the video's). */
  status: VideoDetailStatus | null;
  /** Human readable reasons for an empty / limited reading, for the diagnostics. */
  notes: string[];
}

/**
 * Read everything useful out of the public HTML of a video page.
 *
 * `requested` is what the *request* named (the resolved link). It matters when the page
 * answered from a different URL than the one asked for - TikTok redirects a walled
 * video to its home or login page, whose tags describe TikTok, not the video - so the
 * id and username of the link are never lost, and a page that is demonstrably about
 * something else is not mistaken for the video.
 */
export function inspectVideoPage(html: string, pageUrl: URL, requested?: TikTokUrlParts): VideoPageReading {
  const urlParts = parseTikTokUrl(pageUrl);
  const wantedId = urlParts.videoId ?? requested?.videoId;
  const knownUsername = urlParts.username ?? requested?.username;
  const notes: string[] = [];
  const root = readEmbeddedJson(html);
  const item = root ? findItemStruct(root, wantedId) : null;
  const status = root ? readVideoDetailStatus(root) : null;

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
      status,
      notes,
      info: {
        id: str(item.id) ?? wantedId,
        caption,
        username: str(author?.uniqueId) ?? (typeof item.author === 'string' ? item.author : undefined) ?? knownUsername,
        nickname: str(author?.nickname),
        durationSeconds: int(video?.duration),
        cover: str(video?.cover) ?? str(video?.originCover),
        createdAt: isoFromCreateTime(item.createTime),
        hashtags: [...tags],
        playlist,
        dramaField,
        origin: 'page-json',
      },
    };
  }

  if (status) {
    // The page's own JSON says "no video here": its Open Graph tags are TikTok's stock
    // text, never this video's caption.
    notes.push(`TikTok reports this video as unavailable (statusCode ${status.code}${status.message ? `: ${status.message}` : ''})`);
    return { info: null, status, notes };
  }

  // A playlist / collection page that lists its items in the embedded data.
  if (root && !wantedId) {
    const { playlist, dramaField } = findPlaylist(root, null);
    if (playlist && playlist.items.length > 0) {
      return {
        status,
        notes,
        info: { caption: '', username: knownUsername, hashtags: [], playlist, dramaField, origin: 'page-json' },
      };
    }
  }

  const caption = [metaContent(html, 'og:description'), metaContent(html, 'description'), metaContent(html, 'og:title')].find(
    (text): text is string => !!text && !isGenericTikTokText(text),
  );
  if (!caption) {
    notes.push('page carries no video data and only TikTok\'s generic tags (bot check, login wall or changed layout)');
    return { info: null, status, notes };
  }
  // The tags only describe the video when the page is demonstrably about it: its own URL
  // names it, or an explicit canonical pointer (og:url, canonical, refresh) does.
  const ref = urlParts.videoId ? null : findVideoRefInHtml(html, { scanText: false });
  const id = urlParts.videoId ?? ref?.id;
  if (!id) {
    notes.push('page tags do not name a video (TikTok sent the visitor somewhere else); ignored');
    return { info: null, status, notes };
  }
  if (requested?.videoId && id !== requested.videoId) {
    notes.push(`page is about a different video (${id}); ignored`);
    return { info: null, status, notes };
  }
  return {
    status,
    notes,
    info: {
      id,
      caption,
      username: urlParts.username ?? ref?.username ?? requested?.username,
      hashtags: hashtagsOf(caption),
      cover: metaContent(html, 'og:image'),
      origin: 'meta',
    },
  };
}

export function parseVideoPage(html: string, pageUrl: URL): TikTokVideoInfo | null {
  return inspectVideoPage(html, pageUrl).info;
}

/** All TikTok knows about a link we could not read: the id (and user) the URL itself carries. */
export function linkOnlyInfo(parts: Pick<TikTokUrlParts, 'videoId' | 'username'>): TikTokVideoInfo {
  return { id: parts.videoId, username: parts.username, caption: '', hashtags: [], origin: 'link' };
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

/** `unknown` = TikTok gave no data, so the tool cannot say which of the two it is. */
export type ContentKind = 'mini-drama' | 'normal-video' | 'unknown';
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

export const LINK_ONLY_NOTE =
  'TikTok gave VTGrab no public data for this link (bot check or region block), so only the link itself is listed: ' +
  'the title, episode number and series are unknown. The video id comes from the link, so the optional SSSTik ' +
  'provider (when enabled on this deployment) can still try it.';

export function classify(info: TikTokVideoInfo): Classification {
  if (info.origin === 'link') {
    return {
      kind: 'unknown',
      confidence: 'low',
      score: 0,
      signals: ['only the link was available: TikTok returned no title, hashtags or series data'],
    };
  }
  // The link itself was a playlist / collection and its page listed the items.
  if (!info.id && info.playlist && info.playlist.items.length > 0) {
    const count = Math.max(info.playlist.total ?? 0, info.playlist.items.length);
    return {
      kind: 'mini-drama',
      confidence: 'medium',
      score: 3,
      signals: [`link is a playlist / collection${info.playlist.name ? ` "${info.playlist.name}"` : ''} of ${count} videos`],
    };
  }
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

  if (classification.kind === 'unknown') {
    const title = username ? `@${username} video ${videoId ?? ''}`.trim() : `TikTok video ${videoId ?? ''}`.trim();
    const episodes: TikTokEpisode[] = videoId
      ? [{ index: 1, videoId, title, url: canonicalVideoUrl(username, videoId), current: true }]
      : [];
    return { kind: 'unknown', classification, title, videoId, username, episodes, listComplete: false, listNote: LINK_ONLY_NOTE };
  }

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
