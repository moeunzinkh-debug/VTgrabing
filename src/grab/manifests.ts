import { formatForUrl, normalizeContentType, qualityLabelForHeight } from './media-types';

/**
 * HLS + DASH manifest parsing.
 *
 * These are the two adaptive formats a video host actually exposes, so a real
 * grabber has to understand them: a master playlist says which qualities exist,
 * and a media playlist is the ordered list of byte ranges the finished file is
 * made of.
 *
 * VTGrab reads manifests, it never reads keys. A playlist that declares
 * `#EXT-X-KEY` (AES-128 / SAMPLE-AES / fMP4 encryption) or a DASH representation
 * with `ContentProtection` (Widevine / FairPlay / PlayReady / CENC) is reported as
 * encrypted and refused. There is no decryption code anywhere in this repository.
 */

export interface EncryptionInfo {
  method: string;
  uri?: string;
  /** Key systems named by the manifest (informational, used in the refusal message). */
  drm?: string[];
}

export interface HlsSegment {
  url: string;
  duration?: number;
  title?: string;
  byteRange?: { start: number; length: number };
  encryption?: EncryptionInfo | null;
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[];
  initSegment?: string;
  encryption: EncryptionInfo | null;
  hasEndList: boolean;
  targetDuration?: number;
  mediaSequence?: number;
  playlistType?: 'VOD' | 'EVENT' | 'LIVE';
}

export interface HlsVariant {
  url: string;
  bandwidth?: number;
  averageBandwidth?: number;
  resolution?: { width: number; height: number };
  codecs?: string;
  name?: string;
  video?: string;
  audio?: string;
  subtitles?: string;
  closedCaptions?: string;
}

export interface HlsMaster {
  variants: HlsVariant[];
  iframeVariants: HlsVariant[];
  mediaGroups: Array<{ type: string; groupId: string; uri?: string; name?: string; language?: string }>;
  encryption: EncryptionInfo | null;
  targetDuration?: number;
  mediaSequence?: number;
  playlistType?: 'VOD' | 'EVENT' | 'LIVE';
  hasEndList: boolean;
  isMaster: boolean;
}

export interface PackedSegment {
  url: string;
  duration?: number;
  /** `start+length` for `#EXT-X-BYTERANGE` segments. */
  byteRange?: { start: number; length: number };
}

export interface PackedStream {
  playlistUrl: string;
  kind: 'hls' | 'dash';
  /** `ts` for MPEG-TS segments, `mp4` for fragmented MP4 / CMAF. */
  container: 'ts' | 'mp4';
  initSegmentUrl?: string;
  segments: PackedSegment[];
  /** True when the "manifest" resolves to one complete file. */
  wholeFile: boolean;
  durationSeconds?: number;
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  label?: string;
  live: boolean;
  encryption: EncryptionInfo | null;
}

/** DRM key-system UUIDs, as they appear in DASH `ContentProtection` elements. */
const DRM_UUIDS: Record<string, string> = {
  'edef8ba9-79d6-4ace-a3c8-27d69b85d80d': 'Widevine',
  '9a04f079-9840-4286-ab92-e65be0885f95': 'Widevine (ClearKey variant)',
  '17ee8c60-d885-11df-94d2-0800200c9a66': 'PlayReady',
  '94ce86fb-12ff-43e0-9672-dcb54d8c5b73': 'Marlin',
  'f239e769-efa3-4850-9c16-a903c6932eda': 'FairPlay',
  '1077efec-c0b2-4d02-ace3-3c1e52e2fb41': 'AES-128 (ISO common encryption)',
};

export function detectDrm(text: string): string[] {
  const lower = text.toLowerCase().replace(/\s+/g, '');
  const found = new Set<string>();
  for (const [uuid, name] of Object.entries(DRM_UUIDS)) {
    if (lower.includes(uuid.replace(/-/g, '')) || lower.includes(uuid)) found.add(name);
  }
  if (lower.includes('com.apple.fps') || lower.includes('skd://')) found.add('FairPlay');
  if (lower.includes('widevine')) found.add('Widevine');
  if (lower.includes('playready')) found.add('PlayReady');
  if (lower.includes('cenc:default_kid')) found.add('CENC');
  return [...found];
}

/** Attributes of an `#EXT-X-...` line or an XML tag, honouring quoted strings. */
export function parseAttributes(line: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,"]*))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    attributes[match[1].toUpperCase()] = (match[2] ?? match[3] ?? '').trim();
  }
  return attributes;
}

function toInt(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function absolute(base: URL, candidate: string): string {
  try {
    return new URL(candidate.trim(), base).toString();
  } catch {
    return candidate.trim();
  }
}

function keyInfo(line: string, base: URL): EncryptionInfo | null {
  const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
  const method = (attributes.METHOD ?? 'NONE').toUpperCase();
  if (method === 'NONE') return null;
  return {
    method,
    uri: attributes.URI ? absolute(base, attributes.URI) : undefined,
    drm: attributes.KEYFORMAT?.toLowerCase().includes('fps') ? ['FairPlay'] : undefined,
  };
}

/**
 * Parse an HLS playlist. Both shapes are recognised: a master playlist yields
 * `master.variants` and no media playlist, a media playlist yields `media`.
 */
export function parseHlsPlaylist(text: string, baseUrl: URL | string): {
  master: HlsMaster;
  media: HlsMediaPlaylist | null;
} {
  const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const iframeVariants: HlsVariant[] = [];
  const mediaGroups: HlsMaster['mediaGroups'] = [];
  let pendingStream: HlsVariant | null = null;
  let encryption: EncryptionInfo | null = null;

  const media: HlsMediaPlaylist = { segments: [], encryption: null, hasEndList: false };
  let segmentDuration: number | undefined;
  let segmentTitle: string | undefined;
  let pendingKey: EncryptionInfo | null = null;
  let pendingByteRange: { start: number; length: number } | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
      const resolution = attributes.RESOLUTION?.split('x');
      pendingStream = {
        url: '',
        bandwidth: toInt(attributes.BANDWIDTH),
        averageBandwidth: toInt(attributes['AVERAGE-BANDWIDTH']),
        codecs: attributes.CODECS,
        name: undefined,
        video: attributes.VIDEO,
        audio: attributes.AUDIO,
        subtitles: attributes.SUBTITLES,
        closedCaptions: attributes['CLOSED-CAPTIONS'],
      };
      if (resolution && resolution.length === 2) {
        pendingStream.resolution = {
          width: Number.parseInt(resolution[0], 10) || 0,
          height: Number.parseInt(resolution[1], 10) || 0,
        };
      }
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (attributes.URI) iframeVariants.push(variantFrom(attributes, base));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA')) {
      const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
      mediaGroups.push({
        type: (attributes.TYPE ?? '').toLowerCase(),
        groupId: attributes['GROUP-ID'] ?? '',
        uri: attributes.URI ? absolute(base, attributes.URI) : undefined,
        name: attributes.NAME,
        language: attributes.LANGUAGE,
      });
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const info = keyInfo(line, base);
      pendingKey = info;
      if (info && !encryption) encryption = info;
      if (media.encryption === null && info) media.encryption = info;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP')) {
      const attributes = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (attributes.URI) media.initSegment = absolute(base, attributes.URI);
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION')) {
      media.targetDuration = toNumber(line.split(':')[1]);
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      media.mediaSequence = toInt(line.split(':')[1]);
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      const value = line.split(':')[1]?.trim().toUpperCase();
      if (value === 'VOD' || value === 'EVENT' || value === 'LIVE') media.playlistType = value;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      media.hasEndList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE')) {
      const [length, start] = (line.split(':')[1] ?? '').trim().split('@');
      pendingByteRange = {
        length: toInt(length) ?? 0,
        start: toInt(start) ?? 0,
      };
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const [durationPart, ...titleParts] = line.slice(line.indexOf(':') + 1).split(',');
      segmentDuration = toNumber(durationPart);
      segmentTitle = titleParts.join(',').trim() || undefined;
      continue;
    }
    if (line.startsWith('#')) continue;

    const url = absolute(base, line);
    if (pendingStream) {
      variants.push({ ...pendingStream, url, name: pendingStream.name ?? `stream ${variants.length + 1}` });
      pendingStream = null;
      continue;
    }
    media.segments.push({
      url,
      duration: segmentDuration,
      title: segmentTitle,
      byteRange: pendingByteRange,
      encryption: pendingKey,
    });
    segmentDuration = undefined;
    segmentTitle = undefined;
    pendingByteRange = undefined;
  }

  return {
    master: {
      variants,
      iframeVariants,
      mediaGroups,
      encryption,
      targetDuration: media.targetDuration,
      mediaSequence: media.mediaSequence,
      playlistType: media.playlistType,
      hasEndList: media.hasEndList,
      isMaster: variants.length > 0,
    },
    media: media.segments.length > 0 || media.initSegment !== undefined || encryption !== null ? media : null,
  };
}

function variantFrom(attributes: Record<string, string>, base: URL): HlsVariant {
  const resolution = attributes.RESOLUTION?.split('x');
  return {
    url: attributes.URI ? absolute(base, attributes.URI) : '',
    bandwidth: toInt(attributes.BANDWIDTH),
    averageBandwidth: toInt(attributes['AVERAGE-BANDWIDTH']),
    codecs: attributes.CODECS,
    resolution:
      resolution && resolution.length === 2
        ? { width: Number.parseInt(resolution[0], 10) || 0, height: Number.parseInt(resolution[1], 10) || 0 }
        : undefined,
  };
}

/** Container of a media playlist: fMP4/CMAF when `#EXT-X-MAP` is used, else MPEG-TS. */
export function hlsContainerFor(media: Pick<HlsMediaPlaylist, 'initSegment' | 'segments'>): 'ts' | 'mp4' {
  if (media.initSegment) return 'mp4';
  const sample = media.segments[0]?.url ?? '';
  const container = formatForUrl(sample)?.container;
  if (container === 'mp4' || container === 'm4v' || container === 'm4s' || container === 'mov') return 'mp4';
  if (sample.endsWith('.m4s')) return 'mp4';
  return 'ts';
}

/** Pick the variant that best matches a requested quality label. */
export function pickVariant(variants: HlsVariant[], quality: string): HlsVariant | null {
  if (variants.length === 0) return null;
  const wanted = quality.trim().toLowerCase();
  const wantedHeight = Number.parseInt(wanted, 10);
  if (Number.isFinite(wantedHeight) && wantedHeight > 0) {
    const exact = variants.find((variant) => variant.resolution?.height === wantedHeight);
    if (exact) return exact;
    const heightOf = (variant: HlsVariant): number =>
      variant.resolution?.height ?? Math.round((variant.bandwidth ?? 0) / 4000);
    // Prefer the best rendition that does not exceed what was asked for: a caller
    // who picked "720p" should not silently get a 1080p fetch.
    const fitting = variants.filter((variant) => heightOf(variant) <= wantedHeight);
    const pool = fitting.length > 0 ? fitting : variants;
    return [...pool].sort((a, b) => (b.bandwidth ?? heightOf(b)) - (a.bandwidth ?? heightOf(a)))[0];
  }
  // "source"/"best"/"auto" (and anything unrecognized) = highest bitrate.
  return [...variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}

export function buildPackedHls(
  media: HlsMediaPlaylist,
  playlistUrl: string,
  options: { label?: string; bandwidth?: number; width?: number; height?: number; codecs?: string } = {},
): PackedStream {
  const durationSeconds = media.segments.reduce((total, segment) => total + (segment.duration ?? 0), 0);
  const encryption = media.encryption ?? media.segments.find((segment) => segment.encryption)?.encryption ?? null;
  return {
    playlistUrl,
    kind: 'hls',
    container: hlsContainerFor(media),
    initSegmentUrl: media.initSegment,
    segments: media.segments.map((segment) => ({
      url: segment.url,
      duration: segment.duration,
      byteRange: segment.byteRange,
    })),
    wholeFile: false,
    durationSeconds: durationSeconds > 0 ? Math.round(durationSeconds) : undefined,
    bandwidth: options.bandwidth,
    width: options.width,
    height: options.height,
    codecs: options.codecs,
    label: options.label ?? qualityLabelForHeight(options.height, options.bandwidth),
    live: !media.hasEndList && media.playlistType !== 'VOD',
    encryption,
  };
}

export interface DashRepresentation {
  initUrl?: string;
  segmentUrls: string[];
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  durationSeconds?: number;
  container: 'mp4' | 'ts';
  wholeFile: boolean;
  encryption: EncryptionInfo | null;
}

export interface DashManifest {
  representations: DashRepresentation[];
  durationSeconds?: number;
  encryption: EncryptionInfo | null;
  live: boolean;
}

function attr(node: string, name: string): string | undefined {
  const double = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(node);
  if (double) return double[1];
  const single = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(node);
  return single ? single[1] : undefined;
}

function childTags(text: string, tag: string): string[] {
  return text.match(new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}\\s*>)`, 'gi')) ?? [];
}

/**
 * The `<S>` entries of a DASH `SegmentTimeline`. Real manifests write them
 * self-closing (`<S d="2048"/>`), so both forms have to be accepted. When the
 * timeline sits next to the template instead of inside it (which some encoders
 * emit), entries are read from the wider scope.
 */
function timelineEntries(scope: string): string[] {
  const inner = /<SegmentTimeline(?:\s[^>]*)?>([\s\S]*?)<\/SegmentTimeline\s*>/i.exec(scope)?.[1];
  const haystack = inner ?? scope;
  return haystack.match(/<S\b[^>]*\/?>/g) ?? [];
}

/** Replace `$Number$`, `$Time$`, `$Bandwidth$`, `$RepresentationID$`, `$Number%05d$`. */
export function expandTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\$(?:(Number|Time|Bandwidth|RepresentationID)(?:%0(\d)d)?)\$/g, (whole, name?: string, pad?: string) => {
    if (!name) return whole;
    const value = values[name];
    if (value === undefined) return whole;
    const text = String(value);
    return pad ? text.padStart(Number.parseInt(pad, 10) || 0, '0') : text;
  });
}

/**
 * Pragmatic but real DASH reader: `SegmentTemplate` (with `SegmentTimeline` or a
 * fixed duration), `SegmentList`, and `SegmentBase`/`BaseURL` single files.
 */
export function parseDashManifest(text: string, baseUrl: URL | string): DashManifest {
  const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
  const mpdTag = /<mpd(?:\s[\s\S]*?)?>/i.exec(text)?.[0] ?? '';
  const mediaPresentationDuration = attr(mpdTag, 'mediaPresentationDuration');
  const type = (attr(mpdTag, 'type') ?? 'static').toLowerCase();
  const rootEncryption = encryptionOf(text);
  const mpdBase = joinBase(base, baseUrlOf(text));
  const representations: DashRepresentation[] = [];

  const periods = childTags(text, 'Period');
  const scopes = periods.length > 0 ? periods : [text];

  for (const scope of scopes) {
    const periodBase = joinBase(mpdBase, baseUrlOf(scope));
    const sets = childTags(scope, 'AdaptationSet').length > 0 ? childTags(scope, 'AdaptationSet') : [scope];
    for (const set of sets) {
      const setBase = joinBase(periodBase, baseUrlOf(set));
      const setCodecs = attr(set, 'codecs');
      const setTemplate = /<SegmentTemplate(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/SegmentTemplate\s*>)/i.exec(set)?.[0];

      for (const representation of childTags(set, 'Representation')) {
        const repBase = joinBase(setBase, baseUrlOf(representation));
        const bandwidth = toInt(attr(representation, 'bandwidth'));
        const width = toInt(attr(representation, 'width'));
        const height = toInt(attr(representation, 'height'));
        const codecs = attr(representation, 'codecs') ?? setCodecs;
        const id = attr(representation, 'id') ?? '';
        const encryption = encryptionOf(representation) ?? rootEncryption;
        const template =
          /<SegmentTemplate(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/SegmentTemplate\s*>)/i.exec(representation)?.[0] ??
          setTemplate;

        let initUrl: string | undefined;
        let segmentUrls: string[] = [];
        let durationSeconds: number | undefined;
        let container: 'mp4' | 'ts' = 'mp4';

        if (template) {
          const mediaTemplate = attr(template, 'media');
          const rawInit = attr(template, 'initialization');
          initUrl = rawInit ? joinBase(repBase, expandTemplate(rawInit, { RepresentationID: id, Bandwidth: bandwidth ?? 0 })).toString() : undefined;
          const timescale = toInt(attr(template, 'timescale')) ?? 1;
          const startNumber = toInt(attr(template, 'startnumber')) ?? 1;
          const templateDuration = toInt(attr(template, 'duration'));
          const timeline = timelineEntries(template);
          const values: Record<string, string | number> = { RepresentationID: id, Bandwidth: bandwidth ?? 0 };

          if (timeline.length > 0 && mediaTemplate) {
            let time = 0;
            let number = startNumber;
            let first = true;
            for (const entry of timeline) {
              const t = toInt(attr(entry, 't'));
              const d = toInt(attr(entry, 'd')) ?? 0;
              const r = toInt(attr(entry, 'r')) ?? 0;
              if (t !== undefined) time = t;
              else if (first) first = false;
              for (let repeat = 0; repeat <= Math.max(0, r); repeat += 1) {
                segmentUrls.push(joinBase(repBase, expandTemplate(mediaTemplate, { ...values, Number: number, Time: time })).toString());
                time += d;
                number += 1;
                durationSeconds = (durationSeconds ?? 0) + d / timescale;
              }
            }
          } else if (mediaTemplate && templateDuration && templateDuration > 0) {
            const total = parseIsoDuration(mediaPresentationDuration ?? '') ?? 0;
            const count = total > 0 ? Math.max(1, Math.ceil((total * timescale) / templateDuration)) : 0;
            for (let index = 0; index < count; index += 1) {
              segmentUrls.push(
                joinBase(
                  repBase,
                  expandTemplate(mediaTemplate, { ...values, Number: startNumber + index, Time: index * templateDuration }),
                ).toString(),
              );
              durationSeconds = (durationSeconds ?? 0) + templateDuration / timescale;
            }
          }
        }

        const segmentList = /<SegmentList(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/SegmentList\s*>)/i.exec(representation)?.[0];
        if (segmentList) {
          const rawInit = attr(segmentList, 'initialization') ?? /<Initialization[^>]*sourceURL\s*=\s*"([^"]+)"/i.exec(segmentList)?.[1];
          if (rawInit) initUrl = joinBase(repBase, rawInit).toString();
          segmentUrls = childTags(segmentList, 'SegmentURL')
            .map((entry) => attr(entry, 'media'))
            .filter((entry): entry is string => Boolean(entry))
            .map((entry) => joinBase(repBase, entry).toString());
          const listDuration = toInt(attr(segmentList, 'duration'));
          const timescale = toInt(attr(segmentList, 'timescale')) ?? 1;
          if (listDuration && segmentUrls.length > 0) durationSeconds = (segmentUrls.length * listDuration) / timescale;
        }

        if (segmentUrls.length === 0) {
          // No template/list: a SegmentBase style representation is one file.
          const single = attr(representation, 'BaseURL') ?? (childTags(representation, 'BaseURL')[0] ?? '');
          const candidate = single ? joinBase(repBase, stripTags(single)).toString() : repBase.toString();
          if (formatForUrl(candidate)) {
            representations.push({
              segmentUrls: [candidate],
              bandwidth,
              width,
              height,
              codecs,
              durationSeconds: parseIsoDuration(mediaPresentationDuration ?? ''),
              container: formatForUrl(candidate)?.container === 'ts' ? 'ts' : 'mp4',
              wholeFile: true,
              encryption,
            });
          }
          continue;
        }

        if (initUrl || segmentUrls[0]?.endsWith('.m4s')) container = 'mp4';
        else if (segmentUrls[0]?.endsWith('.ts') || segmentUrls[0]?.endsWith('.m2ts')) container = 'ts';

        representations.push({
          initUrl,
          segmentUrls,
          bandwidth,
          width,
          height,
          codecs,
          durationSeconds: durationSeconds ? Math.round(durationSeconds) : parseIsoDuration(mediaPresentationDuration ?? ''),
          container,
          wholeFile: false,
          encryption,
        });
      }
    }
  }

  return {
    representations,
    durationSeconds: parseIsoDuration(mediaPresentationDuration ?? ''),
    encryption: rootEncryption,
    live: type === 'dynamic',
  };
}

function stripTags(value: string): string {
  return value.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '').trim();
}

function encryptionOf(fragment: string): EncryptionInfo | null {
  const protection = /<ContentProtection(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/ContentProtection\s*>)/i.exec(fragment)?.[0];
  const drm = detectDrm(fragment);
  if (!protection && drm.length === 0) return null;
  const haystack = (protection ?? fragment).toLowerCase();
  const method = haystack.includes('cbcs') ? 'CBCS' : haystack.includes('cenc') ? 'CENC' : 'ENCRYPTED';
  return { method, drm: drm.length > 0 ? drm : ['ContentProtection declared in the manifest'] };
}

/** DASH carries `BaseURL` as a child element whose text is the address. */
function baseUrlOf(scope: string): string | undefined {
  const element = /<BaseURL(?:\s[^>]*)?>([\s\S]*?)<\/BaseURL\s*>/i.exec(scope);
  const value = element?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function joinBase(base: URL, candidate?: string): URL {
  if (!candidate) return base;
  try {
    return new URL(candidate, base);
  } catch {
    return base;
  }
}

/** `PT1H02M03.5S` -> seconds. */
export function parseIsoDuration(raw: string): number | undefined {
  const match =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      raw.trim(),
    );
  if (!match) return undefined;
  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  const value =
    Number(years ?? 0) * 31_536_000 +
    Number(months ?? 0) * 2_592_000 +
    Number(weeks ?? 0) * 604_800 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return value > 0 ? Math.round(value) : undefined;
}

export function isManifestContentType(contentType: string | null | undefined): boolean {
  const type = normalizeContentType(contentType);
  return (
    type === 'application/vnd.apple.mpegurl' ||
    type === 'application/x-mpegurl' ||
    type === 'audio/x-mpegurl' ||
    type === 'audio/mpegurl' ||
    type === 'application/dash+xml'
  );
}
