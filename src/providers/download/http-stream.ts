import { badRequest } from '../../core/errors';
import type { Env } from '../../env';
import { grabEnabled } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import { baseHeaders, grabConfig, type GrabConfig } from '../../grab/config';
import { Budget } from '../../grab/net';
import {
  chunkedDownload,
  fetchRange,
  inspectResource,
  segmentDownload,
  type DownloadProgressUpdate,
  type SegmentInput,
} from '../../grab/fetch-stream';
import { buildPackedHls, parseDashManifest, parseHlsPlaylist, pickVariant, type PackedStream } from '../../grab/manifests';
import { normalizeQualityLabel, resolveFormat } from '../../grab/media-types';
import { HttpSniffExtractor } from '../extract/http-sniff';
import type { DownloadProvider, DownloadRequest, DownloadResult } from './types';

/**
 * The real downloader.
 *
 * `MockDownloadProvider` writes synthetic bytes, `RemoteDownloadProvider` asks
 * somebody else to do the work; this one does the work itself, from inside the
 * Worker, and it is what the "Analyze -> Download" flow uses by default:
 *
 *   progressive file : `Range` chunked GET (resumable, a few chunks of memory)
 *   HLS             : master -> variant -> segments, concatenated in playlist order
 *   DASH            : MPD -> representation -> init segment + segments
 *
 * The result is streamed straight into R2 (`completeJobItemWithStream`), so a file
 * far bigger than the Worker's 128 MB heap is still handled.
 *
 * What it deliberately never does: fetch a decryption key, send a cookie/login, or
 * read DRM protected media. An encrypted playlist is refused and the job item
 * fails with that exact reason, which the UI shows next to the file.
 */
export class HttpStreamDownloadProvider implements DownloadProvider {
  readonly key = 'http-stream';
  readonly label = 'Real HTTP grabber (downloads the source into R2)';
  readonly kind = 'http' as const;

  isConfigured(env: Env): boolean {
    return grabEnabled(env);
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
        ? `Streams real bytes from the source host into R2 (${(cfg.chunkBytes / 1024 / 1024).toFixed(0)} MiB range parts, up to ${(
            cfg.maxVideoBytes / 1024 / 1024 / 1024
          ).toFixed(1)} GiB per object).`
        : 'Disabled: set GRAB_ENABLED=true.',
      docs: 'README.md#real-link-grabbing',
    };
  }

  async start(request: DownloadRequest, env: Env): Promise<DownloadResult> {
    const cfg = grabConfig(env);
    if (!cfg.enabled) throw badRequest('The real HTTP grabber is disabled (set GRAB_ENABLED=true).');

    const budget = new Budget(cfg.maxSubrequests);
    const pageUrl = request.sourceUrl || undefined;
    const headers = baseHeaders(cfg, pageUrl ?? request.streamUrl ?? null);
    const options = { cfg, headers, budget, maxBytes: cfg.maxVideoBytes, mediaContent: true, onProgress: request.onProgress };

    let streamUrl = request.streamUrl;
    let kind = request.streamKind ?? resolveFormat(streamUrl ?? '')?.kind;
    let quality = request.quality;

    // Signed media URLs expire, so a missing URL is rediscovered from the episode
    // page instead of failing the item.
    if (!streamUrl) {
      const discovered = await rediscover(request, env);
      streamUrl = discovered.url;
      kind = discovered.kind ?? kind;
      if (discovered.quality && !Number.isFinite(Number.parseInt(quality, 10))) quality = discovered.quality;
    }
    if (!streamUrl) {
      throw badRequest(
        'This item has no direct media URL and the episode page no longer exposes one. Run Analyze (with refresh) again.',
      );
    }

    // ---- adaptive (segmented) streams --------------------------------------
    if (kind === 'hls' || kind === 'dash' || resolveFormat(streamUrl)?.manifest) {
      const packed = await resolvePackedStream(streamUrl, kind === 'dash' ? 'dash' : 'hls', cfg, budget, headers, quality);
      const assembled = await assemblePacked(packed, options);
      return {
        kind: 'stream',
        stream: assembled.stream,
        contentType: packed.container === 'ts' ? 'video/mp2t' : 'video/mp4',
        container: assembled.container,
        quality: normalizeQualityLabel(packed.label, request.quality),
        contentLength:
          packed.durationSeconds && packed.bandwidth ? Math.round((packed.durationSeconds * packed.bandwidth) / 8) : undefined,
      };
    }

    // ---- progressive file --------------------------------------------------
    const info = await inspectResource(streamUrl, options);
    return {
      kind: 'stream',
      stream: streamFromGenerator(chunkedDownload(streamUrl, info, options)),
      contentType: info.contentType || resolveFormat(streamUrl)?.contentType || 'application/octet-stream',
      contentLength: info.totalBytes ?? undefined,
      container: resolveFormat(streamUrl)?.container ?? (info.contentType?.startsWith('video/mp4') ? 'mp4' : undefined),
    };
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function streamFromGenerator(generator: AsyncGenerator<Uint8Array, void, void>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (next.done) {
          controller.close();
          return;
        }
        if (next.value && next.value.byteLength > 0) controller.enqueue(next.value);
      } catch (error) {
        await generator.return(undefined).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await generator.return(undefined).catch(() => undefined);
    },
  });
}

interface ResolvedVariant {
  url?: string;
  kind?: 'progressive' | 'hls' | 'dash';
  quality?: string;
}

/** Re-open the episode page and take the best unprotected stream from it. */
async function rediscover(request: DownloadRequest, env: Env): Promise<ResolvedVariant> {
  const raw = request.sourceUrl;
  if (!raw) return {};
  let page: URL;
  try {
    page = new URL(raw);
  } catch {
    return {};
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return {};
  try {
    const series = await new HttpSniffExtractor().extract(page, env);
    const episode = series.episodes.find((candidate) => candidate.index === request.episodeIndex) ?? series.episodes[0];
    const stream = episode?.streams.find((candidate) => !candidate.encrypted) ?? episode?.streams[0];
    if (!stream?.url) return {};
    return { url: stream.url, kind: stream.kind, quality: stream.quality };
  } catch (error) {
    throw badRequest(`No media URL recorded for this item and re-analyzing the page failed: ${(error as Error).message}`);
  }
}

/** Master manifest -> the packed (segment level) stream of the best rendition. */
async function resolvePackedStream(
  manifestUrl: string,
  kind: 'hls' | 'dash',
  cfg: GrabConfig,
  budget: Budget,
  headers: Record<string, string>,
  quality: string,
): Promise<PackedStream> {
  const text = await fetchText(manifestUrl, cfg, budget, headers);

  if (kind === 'dash') {
    const manifest = parseDashManifest(text.body, text.url);
    if (manifest.representations.length === 0) {
      throw badRequest(`No usable representation in ${shorten(manifestUrl)} (VTGrab supports SegmentTemplate, SegmentList and single-file representations)`);
    }
    if (manifest.encryption) {
      throw badRequest(
        `This DASH stream is protected (${manifest.encryption.method}${
          manifest.encryption.drm?.length ? ` / ${manifest.encryption.drm.join(', ')}` : ''
        }). VTGrab does not bypass DRM.`,
      );
    }
    if (manifest.live) throw badRequest('This DASH stream is a live broadcast (type="dynamic"), not a finished file.');
    const wanted = Number.parseInt(quality, 10);
    const chosen = [...manifest.representations].sort((a, b) => {
      if (Number.isFinite(wanted) && wanted > 0) {
        const delta = Math.abs((a.height ?? 0) - wanted) - Math.abs((b.height ?? 0) - wanted);
        if (delta !== 0) return delta;
      }
      return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
    })[0]!;
    if (chosen.encryption) {
      throw badRequest(
        `The selected DASH representation is encrypted (${chosen.encryption.method}${
          chosen.encryption.drm?.length ? ` / ${chosen.encryption.drm.join(', ')}` : ''
        }). VTGrab does not bypass DRM.`,
      );
    }
    return {
      playlistUrl: text.url.toString(),
      kind: 'dash',
      container: chosen.container,
      initSegmentUrl: chosen.initUrl,
      segments: chosen.segmentUrls.map((segmentUrl) => ({ url: segmentUrl })),
      wholeFile: chosen.wholeFile,
      durationSeconds: chosen.durationSeconds ?? manifest.durationSeconds,
      bandwidth: chosen.bandwidth,
      width: chosen.width,
      height: chosen.height,
      codecs: chosen.codecs,
      label: normalizeQualityLabel(chosen.height ? `${chosen.height}p` : quality, 'source'),
      live: manifest.live,
      encryption: null,
    };
  }

  const parsed = parseHlsPlaylist(text.body, text.url);

  if (parsed.master.isMaster) {
    const variant = pickVariant(parsed.master.variants, quality);
    if (!variant) throw badRequest(`No variant playlist listed in ${shorten(manifestUrl)}`);
    if (parsed.master.encryption) throw encryptedError(parsed.master.encryption.method);
    const mediaDocument = await fetchText(variant.url, cfg, budget, { ...headers, referer: text.url.toString() });
    const media = parseHlsPlaylist(mediaDocument.body, mediaDocument.url);
    if (!media.media || media.media.segments.length === 0) {
      throw badRequest(`The selected variant ${shorten(variant.url)} contains no segments`);
    }
    if (media.media.encryption) throw encryptedError(media.media.encryption.method);
    const packed = buildPackedHls(media.media, mediaDocument.url.toString(), {
      bandwidth: variant.bandwidth,
      width: variant.resolution?.width,
      height: variant.resolution?.height,
      codecs: variant.codecs,
    });
    if (packed.live) throw badRequest('This HLS playlist has no #EXT-X-ENDLIST (live stream); only finished VOD playlists can be grabbed.');
    return packed;
  }

  if (!parsed.media || parsed.media.segments.length === 0) {
    throw badRequest(`No segments found in ${shorten(manifestUrl)} - it may be a live stream or an unsupported playlist flavour`);
  }
  if (parsed.media.encryption) throw encryptedError(parsed.media.encryption.method);
  const packed = buildPackedHls(parsed.media, text.url.toString());
  if (packed.live) throw badRequest('This HLS playlist has no #EXT-X-ENDLIST (live stream); only finished VOD playlists can be grabbed.');
  return packed;
}

function encryptedError(method: string | undefined): Error {
  return badRequest(
    `This HLS stream declares #EXT-X-KEY:METHOD=${method ?? 'unknown'}, so it is encrypted. VTGrab does not fetch keys or decrypt protected media.`,
  );
}

interface StreamOptions {
  cfg: GrabConfig;
  headers: Record<string, string>;
  budget: Budget;
  maxBytes: number;
  onProgress?: (update: DownloadProgressUpdate) => void | Promise<void>;
}

async function fetchText(url: string, cfg: GrabConfig, budget: Budget, headers: Record<string, string>): Promise<{ body: string; url: URL }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw badRequest(`Not a usable manifest URL: ${shorten(url)}`);
  }
  const bytes = await fetchRange(url, { cfg, headers, budget, maxBytes: cfg.maxPageBytes });
  return { body: new TextDecoder().decode(bytes), url: target };
}

/**
 * Turn a packed stream into one ordered byte stream.
 *
 * MPEG-TS segments are concatenated into a `.ts` file and fragmented-MP4/CMAF
 * segments (init + m4s) into a `.mp4`; both are valid containers for the result,
 * which is exactly what a browser-based grabber without ffmpeg can produce.
 */
async function assemblePacked(packed: PackedStream, options: StreamOptions): Promise<{ stream: ReadableStream<Uint8Array>; container: 'ts' | 'mp4' }> {
  if (packed.segments.length === 0) throw badRequest(`Nothing to download in ${shorten(packed.playlistUrl)}`);
  const single = packed.segments[0]!;

  const asSingleFile =
    packed.wholeFile ||
    (packed.segments.length === 1 && !packed.initSegmentUrl) ||
    (packed.kind === 'dash' && !packed.initSegmentUrl && packed.segments.length <= 1);

  if (asSingleFile && single.url) {
    const info = await inspectResource(single.url, options);
    return {
      stream: streamFromGenerator(chunkedDownload(single.url, info, options)),
      container: resolveFormat(single.url)?.container === 'ts' ? 'ts' : packed.container,
    };
  }

  const initSegment = packed.initSegmentUrl
    ? await fetchRange(packed.initSegmentUrl, { ...options, maxBytes: 16 * 1024 * 1024 })
    : undefined;

  const segments: SegmentInput[] = packed.segments.map((segment) => ({ url: segment.url, byteRange: segment.byteRange }));
  const generator = segmentDownload(segments, {
    cfg: options.cfg,
    headers: options.headers,
    budget: options.budget,
    maxBytes: options.maxBytes,
    onProgress: options.onProgress,
    initSegment,
    concurrency: options.cfg.fetchConcurrency,
  });
  return { stream: streamFromGenerator(generator), container: packed.container };
}

function shorten(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}
