/** Media classification: file extension + Content-Type -> what we can do with it. */

export type MediaKind = 'progressive' | 'hls' | 'dash';

export interface MediaFormat {
  kind: MediaKind;
  /** Container written to R2 (no dot). */
  container: string;
  /** MIME type stored on the R2 object. */
  contentType: string;
  /** True when the payload is a playlist/manifest rather than the media itself. */
  manifest: boolean;
  /** True when the extension is unambiguously audio only. */
  audio?: boolean;
}

const PROGRESSIVE: Record<string, MediaFormat> = {
  mp4: { kind: 'progressive', container: 'mp4', contentType: 'video/mp4', manifest: false },
  m4v: { kind: 'progressive', container: 'm4v', contentType: 'video/x-m4v', manifest: false },
  mov: { kind: 'progressive', container: 'mov', contentType: 'video/quicktime', manifest: false },
  webm: { kind: 'progressive', container: 'webm', contentType: 'video/webm', manifest: false },
  mkv: { kind: 'progressive', container: 'mkv', contentType: 'video/x-matroska', manifest: false },
  ogv: { kind: 'progressive', container: 'ogv', contentType: 'video/ogg', manifest: false },
  avi: { kind: 'progressive', container: 'avi', contentType: 'video/x-msvideo', manifest: false },
  flv: { kind: 'progressive', container: 'flv', contentType: 'video/x-flv', manifest: false },
  '3gp': { kind: 'progressive', container: '3gp', contentType: 'video/3gpp', manifest: false },
  mpg: { kind: 'progressive', container: 'mpg', contentType: 'video/mpeg', manifest: false },
  mpeg: { kind: 'progressive', container: 'mpeg', contentType: 'video/mpeg', manifest: false },
  'vob': { kind: 'progressive', container: 'vob', contentType: 'video/x-ms-vob', manifest: false },
  ts: { kind: 'progressive', container: 'ts', contentType: 'video/mp2t', manifest: false },
  m2ts: { kind: 'progressive', container: 'm2ts', contentType: 'video/mp2t', manifest: false },
  m4s: { kind: 'progressive', container: 'm4s', contentType: 'video/iso.segment', manifest: false },
  mp3: { kind: 'progressive', container: 'mp3', contentType: 'audio/mpeg', manifest: false, audio: true },
  m4a: { kind: 'progressive', container: 'm4a', contentType: 'audio/mp4', manifest: false, audio: true },
  aac: { kind: 'progressive', container: 'aac', contentType: 'audio/aac', manifest: false, audio: true },
  opus: { kind: 'progressive', container: 'opus', contentType: 'audio/opus', manifest: false, audio: true },
  oga: { kind: 'progressive', container: 'oga', contentType: 'audio/ogg', manifest: false, audio: true },
  wav: { kind: 'progressive', container: 'wav', contentType: 'audio/wav', manifest: false, audio: true },
  flac: { kind: 'progressive', container: 'flac', contentType: 'audio/flac', manifest: false, audio: true },
};

const MANIFEST: Record<string, MediaFormat> = {
  m3u8: { kind: 'hls', container: 'mp4', contentType: 'application/vnd.apple.mpegurl', manifest: true },
  m3u: { kind: 'hls', container: 'mp4', contentType: 'audio/x-mpegurl', manifest: true },
  mpd: { kind: 'dash', container: 'mp4', contentType: 'application/dash+xml', manifest: true },
};

/** `video/mp4; codecs=...` -> the bare type. */
export function normalizeContentType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

export function extensionOf(pathOrUrl: string): string {
  let path = pathOrUrl;
  try {
    path = path.startsWith('http') ? new URL(path).pathname : path;
  } catch {
    // keep as is
  }
  const cleaned = path.split('?')[0].split('#')[0];
  const dot = cleaned.lastIndexOf('.');
  if (dot < 0 || dot < cleaned.lastIndexOf('/')) return '';
  const ext = cleaned.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : '';
}

export function formatForUrl(url: string): MediaFormat | null {
  const ext = extensionOf(url);
  if (ext === '') return null;
  return MANIFEST[ext] ?? PROGRESSIVE[ext] ?? null;
}

export function formatForContentType(contentType: string | null | undefined): MediaFormat | null {
  const type = normalizeContentType(contentType);
  switch (type) {
    case 'application/vnd.apple.mpegurl':
    case 'application/x-mpegurl':
    case 'audio/x-mpegurl':
    case 'audio/mpegurl':
      return MANIFEST.m3u8;
    case 'application/dash+xml':
    case 'video/mpeg-dash+xml':
      return MANIFEST.mpd;
    case 'video/mp4':
      return PROGRESSIVE.mp4;
    case 'video/x-m4v':
      return PROGRESSIVE.m4v;
    case 'video/quicktime':
      return PROGRESSIVE.mov;
    case 'video/webm':
      return PROGRESSIVE.webm;
    case 'video/x-matroska':
      return PROGRESSIVE.mkv;
    case 'video/ogg':
      return PROGRESSIVE.ogv;
    case 'video/mp2t':
    case 'video/mpeg2t':
      return PROGRESSIVE.ts;
    case 'video/x-flv':
      return PROGRESSIVE.flv;
    case 'video/x-msvideo':
      return PROGRESSIVE.avi;
    case 'video/3gpp':
      return PROGRESSIVE['3gp'];
    case 'video/mpeg':
      return PROGRESSIVE.mpg;
    case 'audio/mpeg':
      return PROGRESSIVE.mp3;
    case 'audio/mp4':
    case 'audio/x-m4a':
      return PROGRESSIVE.m4a;
    case 'audio/aac':
      return PROGRESSIVE.aac;
    case 'audio/opus':
      return PROGRESSIVE.opus;
    case 'audio/ogg':
      return PROGRESSIVE.oga;
    case 'audio/wav':
    case 'audio/x-wav':
      return PROGRESSIVE.wav;
    case 'audio/flac':
      return PROGRESSIVE.flac;
    default:
      return null;
  }
}

/** `video/*` (and audio) is what a media host must answer for us to trust a URL. */
/**
 * Types that prove a response is *not* the media we asked for: an HTML error page, a
 * JSON body, an image, plain text. CDNs also answer `application/octet-stream` for real
 * video, so this list is deliberately narrow and only used to reject the obvious cases
 * (storing an error page as `.mp4` is the classic fake success).
 */
export function isErrorPageContentType(contentType: string | null | undefined): boolean {
  const type = normalizeContentType(contentType);
  if (!type) return false;
  return (
    type === 'text/html' ||
    type === 'text/css' ||
    type === 'text/xml' ||
    type === 'text/javascript' ||
    type === 'application/xhtml+xml' ||
    type === 'application/xml' ||
    type === 'application/json' ||
    type.startsWith('application/json+') ||
    type.startsWith('application/javascript') ||
    type.startsWith('text/javascript') ||
    type.startsWith('image/')
  );
}

export function isMediaContentType(contentType: string | null | undefined): boolean {
  const type = normalizeContentType(contentType);
  return type.startsWith('video/') || type.startsWith('audio/') || formatForContentType(type) !== null;
}

/** Prefer the extension, fall back to the MIME type (they sometimes disagree). */
export function resolveFormat(url: string, contentType?: string | null): MediaFormat | null {
  return formatForUrl(url) ?? formatForContentType(contentType);
}

const HEIGHT_LABELS: Array<[number, string]> = [
  [4320, '8K'],
  [2160, '2160p'],
  [1440, '1440p'],
  [1080, '1080p'],
  [720, '720p'],
  [576, '576p'],
  [480, '480p'],
  [360, '360p'],
  [288, '288p'],
  [240, '240p'],
  [144, '144p'],
];

export function qualityLabelForHeight(height: number | undefined, bandwidth?: number): string {
  if (height && height > 0) {
    let best = HEIGHT_LABELS[HEIGHT_LABELS.length - 1];
    for (const entry of HEIGHT_LABELS) {
      if (height >= entry[0]) {
        best = entry;
        break;
      }
    }
    return best[1];
  }
  if (bandwidth && bandwidth > 0) {
    const kbps = bandwidth / 1000;
    if (kbps >= 6000) return '2160p';
    if (kbps >= 3500) return '1080p';
    if (kbps >= 1800) return '720p';
    if (kbps >= 900) return '480p';
    if (kbps >= 400) return '360p';
    return '240p';
  }
  return 'source';
}

/** Normalize `1080P`, `Full HD`, `HD 1280x720` style labels to `1080p`. */
export function normalizeQualityLabel(raw: string | undefined, fallback = 'source'): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  const resolution = /(\d{3,4})\s*[x*]\s*(\d{3,4})/.exec(value);
  if (resolution) return qualityLabelForHeight(Number.parseInt(resolution[2], 10));
  const height = /(\d{3,4})p?($|[^a-z0-9])/.exec(value);
  if (height) {
    const parsed = Number.parseInt(height[1], 10);
    if (parsed >= 120 && parsed <= 8640) return qualityLabelForHeight(parsed);
  }
  if (/\b(4k|uhd)\b/.test(value)) return '2160p';
  if (/\bfhd\b|full\s*hd|\b1080\b/.test(value)) return '1080p';
  if (/\bhd\b|high\s*def/.test(value)) return '720p';
  if (/\bsd\b|standard\s*def/.test(value)) return '480p';
  if (/\baudio\b|\bmp3\b/.test(value)) return 'audio';
  return value.slice(0, 32);
}

/** Bytes -> a short human readable size for the UI (server side copy too). */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
