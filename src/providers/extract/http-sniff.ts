import { badRequest } from '../../core/errors';
import type { Env } from '../../env';
import { grabEnabled } from '../../env';
import type { ProviderDescriptor, StreamInfo } from '../../shared/types';
import { grabConfig, baseHeaders, type GrabConfig } from '../../grab/config';
import { trySafeUrl } from '../../grab/guard';
import { Budget, grabFetch, readTextLimited } from '../../grab/net';
import { isManifestContentType, parseDashManifest, parseHlsPlaylist } from '../../grab/manifests';
import { formatBytes, normalizeQualityLabel, qualityLabelForHeight, resolveFormat } from '../../grab/media-types';
import { dedupeCandidates, orderHintFromUrl, sniffDocument, titleFromUrl, type SniffedCandidate, type SniffResult } from '../../grab/sniff';
import type { ExtractedEpisode, ExtractedSeries, SourceExtractor } from './types';

/**
 * The real "open this link and find the videos" extractor.
 *
 * It fetches the URL the user typed, reads what the server actually returns, and
 * collects **every** video source on it:
 *
 *   1. `<video>` / `<source>` / `<a href="*.mp4">` / `data-*` / `og:video` markup
 *   2. inline player config (jwplayer/videojs `sources:[{file,label}]`)
 *   3. `application/ld+json` blocks and JSON API responses
 *   4. `<iframe>` players on the page (opened as an extra document)
 *   5. episode-looking links on the same origin, when the page is a series index
 *
 * Nothing is invented: every candidate is validated against the media host itself
 * (HEAD / manifest GET), so the quality labels, byte sizes, durations and the
 * encrypted-or-not verdict all come from real responses.
 */

export interface ProbeResult {
  ok: boolean;
  contentType?: string;
  sizeBytes?: number;
  acceptsRanges?: boolean;
  reason?: string;
}

export interface ManifestInfo {
  container: 'ts' | 'mp4';
  qualities: Array<{ quality: string; bandwidth?: number; height?: number; width?: number; codecs?: string; url: string }>;
  durationSeconds?: number;
  segmentCount?: number;
  sizeBytesEstimate?: number;
  encrypted: boolean;
  encryptionMethod?: string;
  drm?: string[];
  live: boolean;
  /**
   * For a master playlist: the URL of the rendition that was picked. A master carries no
   * `#EXT-X-KEY`, no segment list and no `#EXT-X-ENDLIST`, so the honest duration,
   * segment count, encryption verdict and VOD/live answer only exist one level down.
   */
  variantUrl?: string;
}

type GrabStream = StreamInfo & {
  sizeBytes?: number;
  segments?: number;
  encrypted?: boolean;
  note?: string;
  pageUrl?: string;
};

interface EpisodeDraft {
  title: string;
  pageUrl: string;
  posterUrl?: string;
  orderHint?: number;
  foundOrder: number;
  streams: GrabStream[];
}

interface DraftWithKey {
  groupKey: string;
  draft: EpisodeDraft;
}

interface FetchedDocument {
  sniff: SniffResult | null;
  /** Set when the URL is itself a media file or a manifest instead of a page. */
  directMedia: SniffedCandidate | null;
  /** Raw manifest body, only for `directMedia` manifests. */
  body: string;
  contentType: string;
}

type Trace = (message: string) => void;

export class HttpSniffExtractor implements SourceExtractor {
  readonly key = 'http-sniff';
  readonly label = 'Real link grabber (open the URL, find every video)';
  readonly kind = 'http' as const;

  isConfigured(env: Env): boolean {
    return grabEnabled(env);
  }

  /** Any public http(s) URL; reserved/mock hosts stay with the other extractors. */
  canHandle(url: URL, env: Env): boolean {
    const cfg = grabConfig(env);
    if (!cfg.enabled) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    const reserved = /^(localhost|.*\.(?:local|test|example|invalid|internal|intranet|lan|home))$/.test(host);
    if (reserved && !cfg.allowPrivateHosts) return false;
    if (cfg.allowlist.length > 0 && !cfg.allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`))) return false;
    if (cfg.denylist.some((entry) => host === entry || host.endsWith(`.${entry}`))) return false;
    return true;
  }

  async extract(url: URL, env: Env, signal?: AbortSignal): Promise<ExtractedSeries> {
    const cfg = grabConfig(env);
    if (!cfg.enabled) throw badRequest('The real link grabber is disabled (set GRAB_ENABLED=true).');

    const budget = new Budget(cfg.maxSubrequests);
    const diagnostics: string[] = [];
    const trace: Trace = (message) => {
      diagnostics.push(message);
      console.log(`[vtgrab][grab] ${message}`);
    };

    // ---- 1. open the link --------------------------------------------------
    const page = await fetchDocument(url, cfg, signal, budget, trace, null, 0);
    if (!page) {
      throw badRequest(`Could not read ${url.toString()}: unreachable, blocked by policy, or not an HTML/JSON document.`, {
        diagnostics,
      });
    }

    // The link is itself the media file or a manifest: one video.
    if (page.directMedia) {
      const candidate = page.directMedia;
      const isManifest = candidate.kind === 'hls' || candidate.kind === 'dash';
      const manifest = isManifest ? await readManifest(candidate, cfg, signal, budget, trace, page.body) : null;
      const probed = manifest ? undefined : await probeMedia(candidate.url, cfg, url, signal, budget, trace);
      if (probed && !probed.ok) {
        throw badRequest(`The media host refused ${candidate.url}: ${probed.reason ?? 'unreachable'}`, { diagnostics });
      }
      const { draft } = buildEpisodeDraft(candidate, manifest, 0, probed);
      return finalizeSeries([draft], {
        url,
        title: candidate.title || titleFromUrl(candidate.url, url.hostname),
        diagnostics,
        pageKind: 'media',
      });
    }

    // ---- 2. every candidate on the page, plus its embedded players --------
    const documents = new Map<string, URL>();
    documents.set(url.toString(), url);
    const collected: SniffedCandidate[] = [...page.sniff!.candidates];

    if (cfg.followEmbeds && cfg.maxDepth > 1 && page.sniff!.embeds.length > 0) {
      for (const embed of page.sniff!.embeds.slice(0, 6)) {
        const embedUrl = trySafeUrl(embed, cfg, url);
        if (!embedUrl || documents.has(embedUrl.toString())) continue;
        const embedDocument = await fetchDocument(embedUrl, cfg, signal, budget, trace, url, 1);
        if (!embedDocument?.sniff && !embedDocument?.directMedia) continue;
        documents.set(embedUrl.toString(), embedUrl);
        if (embedDocument.directMedia) collected.push(embedDocument.directMedia);
        else collected.push(...(embedDocument.sniff?.candidates ?? []));
        trace(`opened embedded player ${embedUrl.href}: ${(embedDocument.sniff?.candidates.length ?? 1)} candidate(s)`);
      }
    }

    let candidates = dedupeCandidates(collected).slice(0, cfg.maxCandidates);
    const crawledDrafts: EpisodeDraft[] = [];

    // ---- 3. a series index page? follow the episode links -----------------
    if (candidates.length === 0 && cfg.crawl) {
      const links = [...new Set(page.sniff!.episodeLinks)].slice(0, cfg.maxCrawlPages);
      if (links.length > 0) {
        trace(`no media directly on ${url.href} - crawling ${links.length} episode-looking link(s)`);
        let order = 0;
        for (const href of links) {
          const episodeUrl = trySafeUrl(href, cfg, url);
          if (!episodeUrl || documents.has(episodeUrl.toString())) continue;
          documents.set(episodeUrl.toString(), episodeUrl);

          const crawled = await fetchDocument(episodeUrl, cfg, signal, budget, trace, url, 1);
          if (!crawled) continue;
          const found = crawled.directMedia
            ? [crawled.directMedia]
            : dedupeCandidates(crawled.sniff?.candidates ?? []).slice(0, 12);
          if (found.length === 0) {
            trace(`${episodeUrl.href}: no video source found`);
            continue;
          }

          const draft = await buildDraftForPage(found, crawled.sniff?.pageTitle, crawled.sniff?.pageImage, episodeUrl, order, cfg, signal, budget, trace);
          if (draft) {
            crawledDrafts.push(draft);
            order += 1;
          }
          if (crawledDrafts.length >= cfg.maxVideos) break;
        }
      }
    }

    if (candidates.length === 0 && crawledDrafts.length === 0) {
      throw badRequest(
        `Opened ${url.toString()} but found no publicly reachable video source in the HTML, the embedded players or the linked episode pages.`,
        {
          diagnostics,
          hint:
            'That usually means the player is rendered later by JavaScript, the media needs a login, or the stream is DRM protected. ' +
            'VTGrab sends no cookies and never decrypts anything, so those cases are refused by design.',
        },
      );
    }

    // ---- 4. confirm every candidate against the media host ----------------
    interface Validated {
      candidate: SniffedCandidate;
      manifest: ManifestInfo | null;
      probed: ProbeResult;
      index: number;
    }
    const validated = new Map<number, Validated>();
    await mapWithConcurrency(candidates, cfg.fetchConcurrency, async (candidate, index) => {
      const manifest =
        candidate.kind === 'hls' || candidate.kind === 'dash' ? await readManifest(candidate, cfg, signal, budget, trace) : null;
      const probed = manifest
        ? { ok: true, sizeBytes: manifest.sizeBytesEstimate }
        : cfg.probe
          ? await probeMedia(candidate.url, cfg, url, signal, budget, trace)
          : { ok: true };
      validated.set(index, { candidate, manifest, probed, index });
    });

    const accepted = [...validated.values()]
      .filter(Boolean)
      .filter((entry) => entry.probed.ok || entry.manifest !== null)
      .sort((a, b) => a.index - b.index);
    for (const entry of validated.values()) {
      if (entry && !entry.probed.ok && !entry.manifest) {
        trace(`dropped ${shorten(entry.candidate.url)}: ${entry.probed.reason ?? 'the media host did not confirm it'}`);
      }
    }
    if (accepted.length === 0) {
      throw badRequest(`Found ${candidates.length} media-looking URL(s) on ${url.toString()}, but the media host rejected all of them.`, {
        diagnostics,
        candidates: candidates.slice(0, 20).map((candidate) => candidate.url),
      });
    }

    // ---- 5. merge renditions of the same video, keep separate videos apart -
    const groups = new Map<string, EpisodeDraft>();
    for (const entry of accepted) {
      const built = buildEpisodeDraft(entry.candidate, entry.manifest, entry.index, entry.probed);
      const existing = groups.get(built.groupKey);
      if (existing) {
        existing.streams.push(...built.draft.streams);
        existing.posterUrl ??= built.draft.posterUrl;
        existing.orderHint ??= built.draft.orderHint;
      } else {
        groups.set(built.groupKey, built.draft);
      }
    }

    for (const draft of groups.values()) {
      draft.streams = dedupeStreams(draft.streams);
    }

    const grouped = [...groups.values()].sort((a, b) => {
      const left = a.orderHint;
      const right = b.orderHint;
      if (left !== undefined && right !== undefined && left !== right) return left - right;
      if (left !== undefined && right === undefined) return -1;
      if (right !== undefined && left === undefined) return 1;
      return a.foundOrder - b.foundOrder;
    });

    const all = [...grouped, ...crawledDrafts].slice(0, cfg.maxVideos);
    if (grouped.length + crawledDrafts.length > all.length) {
      trace(`capped the result at ${cfg.maxVideos} videos (${grouped.length + crawledDrafts.length} found)`);
    }
    if (all.length === 0) throw badRequest(`No grabbable video could be confirmed on ${url.toString()}.`, { diagnostics });

    return finalizeSeries(all, {
      url,
      title: page.sniff!.pageTitle || titleFromUrl(url.pathname, url.hostname) || url.hostname,
      posterUrl: page.sniff!.pageImage,
      synopsis: page.sniff!.pageDescription,
      diagnostics,
      pageKind: 'html',
      crawledPages: [...documents.values()].map((document) => document.toString()),
    });
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
        ? `Opens the page for real and finds every <video>/<source>/HLS/DASH/direct file URL on it (${
            cfg.allowlist.length > 0 ? `hosts: ${cfg.allowlist.join(', ')}` : 'any public host'
          }); each candidate is confirmed with HEAD.`
        : 'Disabled: set GRAB_ENABLED=false.',
      docs: 'README.md#real-link-grabbing',
    };
  }
}

// ---------------------------------------------------------------------------
// page fetching
// ---------------------------------------------------------------------------

function shorten(value: string): string {
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

function heightOf(stream: StreamInfo): number {
  const match = /(\d{3,4})p?$/i.exec(stream.quality ?? '');
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const size = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index]!, index);
      }
    }),
  );
}

async function fetchDocument(
  url: URL,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
  refererPage: URL | null,
  depth: number,
): Promise<FetchedDocument | null> {
  const format = resolveFormat(`${url.pathname}${url.search}`);
  try {
    const { response } = await grabFetch(
      url,
      cfg,
      {
        method: 'GET',
        headers: {
          ...baseHeaders(cfg, refererPage?.toString() ?? null),
          accept: 'text/html, application/xhtml+xml, application/json;q=0.9, application/xml;q=0.8, */*;q=0.5',
        },
        timeoutMs: cfg.pageTimeoutMs,
        signal,
      },
      budget,
    );
    const contentType = response.headers.get('content-type') ?? '';
    const body = await readTextLimited(response, cfg.maxPageBytes, url);
    const manifestBody = body.text.trimStart().startsWith('#EXTM3U');

    if (manifestBody || format?.manifest || isManifestContentType(contentType)) {
      return {
        sniff: null,
        directMedia: {
          url: url.toString(),
          kind: format?.kind === 'dash' && !manifestBody ? 'dash' : 'hls',
          container: 'mp4',
          foundBy: 'manifest',
          title: titleFromUrl(url.toString(), url.hostname),
          pageUrl: url.toString(),
          depth,
        },
        body: body.text,
        contentType,
      };
    }

    if (format && !format.manifest && !/^text\/html/i.test(contentType)) {
      return {
        sniff: null,
        directMedia: {
          url: url.toString(),
          kind: format.kind,
          container: format.container,
          foundBy: 'raw-scan',
          title: titleFromUrl(url.toString(), url.hostname),
          pageUrl: url.toString(),
          depth,
          orderHint: orderHintFromUrl(url.toString()),
        },
        body: '',
        contentType,
      };
    }

    if (/^text\/html|^application\/xhtml/i.test(contentType) || /<html|<!doctype/i.test(body.text.slice(0, 2048))) {
      const sniff = sniffDocument(body.text, url, { depth, maxCandidates: cfg.maxCandidates });
      trace(
        `opened ${url.href} (${formatBytes(body.bytes)}, ${contentType.split(';')[0] || 'unknown type'}) -> ` +
          `${sniff.candidates.length} media URL(s), ${sniff.embeds.length} player embed(s), ${sniff.episodeLinks.length} episode link(s)`,
      );
      return { sniff, directMedia: null, body: '', contentType };
    }

    const trimmed = body.text.trimStart();
    if (/json/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const sniff = sniffDocument(body.text, url, { depth, maxCandidates: cfg.maxCandidates });
      trace(`read JSON endpoint ${url.href} -> ${sniff.candidates.length} media URL(s)`);
      return { sniff, directMedia: null, body: '', contentType };
    }

    trace(`skipped ${url.href}: content-type "${contentType.split(';')[0] || 'unknown'}" is not a document we can scan`);
    return null;
  } catch (error) {
    trace(`could not open ${url.href}: ${(error as Error).message}`);
    return null;
  }
}

/** Confirm a candidate really is media on that host, and learn its size. */
async function probeMedia(
  url: string,
  cfg: GrabConfig,
  pageUrl: URL,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<ProbeResult> {
  const headers = baseHeaders(cfg, pageUrl.toString());

  const attempt = async (method: 'HEAD' | 'GET'): Promise<ProbeResult> => {
    try {
      const { response } = await grabFetch(
        url,
        cfg,
        {
          method,
          headers: method === 'GET' ? { ...headers, range: 'bytes=0-1' } : headers,
          timeoutMs: cfg.pageTimeoutMs,
          signal,
        },
        budget,
      );
      void response.body?.cancel().catch(() => undefined);
      const contentType = response.headers.get('content-type') ?? '';
      if (/^text\/html|^application\/xml|^application\/json|javascript|(^|\/)css(;|$)/i.test(contentType)) {
        return { ok: false, contentType, reason: `the host answered "${contentType.split(';')[0]}" instead of media` };
      }

      let sizeBytes: number | undefined;
      const totalMatch = response.headers.get('content-range') ? /\/(\d+)\s*$/.exec(response.headers.get('content-range')!) : null;
      if (totalMatch?.[1]) sizeBytes = Number.parseInt(totalMatch[1], 10);
      const lengthHeader = response.headers.get('content-length');
      if (sizeBytes === undefined && lengthHeader) {
        const parsed = Number.parseInt(lengthHeader, 10);
        // A 2 byte ranged GET says nothing about the total size.
        if (!(method === 'GET' && parsed <= 4) && Number.isFinite(parsed)) sizeBytes = parsed;
      }
      return {
        ok: true,
        contentType,
        sizeBytes,
        acceptsRanges: (response.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes') || response.status === 206,
      };
    } catch (error) {
      const message = (error as Error).message;
      if (method === 'HEAD') return attempt('GET');
      return { ok: false, reason: message };
    }
  };

  const result = await attempt('HEAD');
  if (!result.ok) trace(`probe failed for ${shorten(url)}: ${result.reason ?? 'the host did not confirm media'}`);
  return result;
}

// ---------------------------------------------------------------------------
// manifests
// ---------------------------------------------------------------------------

async function readManifest(
  candidate: SniffedCandidate,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
  prefetchedBody?: string,
): Promise<ManifestInfo | null> {
  try {
    const base = new URL(candidate.url);
    if (prefetchedBody) return await enrichFromVariant(await describeManifest(prefetchedBody, base, candidate, trace), candidate, cfg, signal, budget, trace);
    const { response, url } = await grabFetch(
      candidate.url,
      cfg,
      { method: 'GET', headers: baseHeaders(cfg, candidate.pageUrl), timeoutMs: cfg.pageTimeoutMs, signal },
      budget,
    );
    const body = await readTextLimited(response, cfg.maxPageBytes, url);
    return await enrichFromVariant(await describeManifest(body.text, url, candidate, trace), candidate, cfg, signal, budget, trace);
  } catch (error) {
    trace(`manifest read failed for ${shorten(candidate.url)}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * A master playlist only lists renditions; the facts that matter for a download (how many
 * segments, how long, encrypted or not, VOD or live) live in the rendition playlist. One
 * extra request per adaptive source is worth it: it is what lets the app say
 * "this one is protected" before anything is queued.
 */
async function enrichFromVariant(
  info: ManifestInfo | null,
  candidate: SniffedCandidate,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<ManifestInfo | null> {
  if (!info?.variantUrl) return info;
  try {
    const { response, url } = await grabFetch(
      info.variantUrl,
      cfg,
      { method: 'GET', headers: baseHeaders(cfg, candidate.pageUrl ?? candidate.url), timeoutMs: cfg.pageTimeoutMs, signal },
      budget,
    );
    const body = await readTextLimited(response, cfg.maxPageBytes, url);
    const rendition = describeManifest(body.text, url, { ...candidate, url: url.toString() }, trace);
    if (!rendition) return info;
    return {
      ...rendition,
      // The renditions listed by the master stay, each with its own playlist URL.
      qualities: info.qualities.length > 0 ? info.qualities : rendition.qualities,
      variantUrl: undefined,
    };
  } catch (error) {
    trace(`rendition playlist ${shorten(info.variantUrl)} could not be read: ${(error as Error).message}`);
    return info;
  }
}

/** Read the real qualities/duration/segment count/encryption out of a manifest. */
function describeManifest(text: string, url: URL, candidate: SniffedCandidate, trace: Trace): ManifestInfo | null {
  if (/\.mpd(\?|$)/i.test(url.pathname) || /<mpd[\s>]/i.test(text.slice(0, 512))) {
    const manifest = parseDashManifest(text, url);
    if (manifest.representations.length === 0) {
      trace(`DASH manifest ${shorten(url.href)} has no expandable representation`);
      return null;
    }
    const drm = [
      ...new Set(
        manifest.representations
          .flatMap((representation) => representation.encryption?.drm ?? [])
          .concat(manifest.encryption?.drm ?? []),
      ),
    ];
    return {
      container: manifest.representations[0]?.container ?? 'mp4',
      // A DASH rendition is selected by re-reading the MPD, so every quality keeps the
      // manifest URL: "the first segment of the template" is not something a downloader
      // can turn back into a video.
      qualities: manifest.representations.map((representation) => ({
        quality: qualityLabelForHeight(representation.height, representation.bandwidth),
        bandwidth: representation.bandwidth,
        height: representation.height,
        width: representation.width,
        codecs: representation.codecs,
        url: url.href,
      })),
      durationSeconds: manifest.durationSeconds,
      segmentCount: Math.max(...manifest.representations.map((representation) => representation.segmentUrls.length)),
      sizeBytesEstimate: estimateBytes(
        manifest.durationSeconds,
        Math.max(...manifest.representations.map((representation) => representation.bandwidth ?? 0)),
      ),
      encrypted: Boolean(manifest.encryption) || manifest.representations.some((representation) => representation.encryption),
      encryptionMethod: manifest.encryption?.method ?? manifest.representations.find((r) => r.encryption)?.encryption?.method,
      drm: drm.length > 0 ? drm : undefined,
      live: manifest.live,
    };
  }

  const parsed = parseHlsPlaylist(text, url);
  if (parsed.master.isMaster) {
    const best = [...parsed.master.variants].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    return {
      container: 'mp4',
      qualities: parsed.master.variants.map((variant) => ({
        quality: qualityLabelForHeight(variant.resolution?.height, variant.bandwidth),
        bandwidth: variant.bandwidth,
        height: variant.resolution?.height,
        width: variant.resolution?.width,
        codecs: variant.codecs,
        url: variant.url,
      })),
      // Only what the master itself declares: keys/segments/end-list are per rendition.
      encrypted: Boolean(parsed.master.encryption),
      encryptionMethod: parsed.master.encryption?.method,
      live: false,
      variantUrl: best?.url,
    };
  }

  if (parsed.media) {
    const duration = parsed.media.segments.reduce((total, segment) => total + (segment.duration ?? 0), 0);
    return {
      container: parsed.media.initSegment ? 'mp4' : 'ts',
      qualities: [{ quality: normalizeQualityLabel(candidate.quality ?? 'source', 'source'), url: url.href }],
      durationSeconds: duration > 0 ? Math.round(duration) : undefined,
      segmentCount: parsed.media.segments.length,
      sizeBytesEstimate: estimateBytes(duration, candidate.bitrateKbps ? candidate.bitrateKbps * 1000 : undefined),
      encrypted: Boolean(parsed.media.encryption),
      encryptionMethod: parsed.media.encryption?.method,
      live: !parsed.media.hasEndList && parsed.media.playlistType !== 'VOD',
    };
  }

  trace(`could not parse the manifest at ${shorten(url.href)}`);
  return null;
}

/** True when every stream of this video is a running playlist rather than a finished file. */
function allStreamsLive(draft: EpisodeDraft): boolean {
  return draft.streams.length > 0 && draft.streams.every((stream) => stream.live === true);
}

function estimateBytes(durationSeconds: number | undefined, bitrate: number | undefined): number | undefined {
  if (!durationSeconds || !bitrate || bitrate <= 0) return undefined;
  return Math.round((durationSeconds * bitrate) / 8);
}

function manifestNote(manifest: ManifestInfo | null): string | undefined {
  if (!manifest) return undefined;
  if (manifest.encrypted) {
    return `Encrypted (${manifest.encryptionMethod ?? 'DRM'}${manifest.drm?.length ? ` / ${manifest.drm.join(', ')}` : ''}) - listed so you can see it, but VTGrab does not fetch keys or decrypt protected media.`;
  }
  if (manifest.live) return 'Live playlist: only finished (VOD) playlists can be downloaded.';
  if (manifest.container === 'ts') return 'MPEG-TS segments concatenated into one .ts file (the source has no remuxer available here).';
  return undefined;
}

// ---------------------------------------------------------------------------
// episode assembly
// ---------------------------------------------------------------------------

function buildEpisodeDraft(candidate: SniffedCandidate, manifest: ManifestInfo | null, order: number, probed?: ProbeResult): DraftWithKey {
  const fallbackTitle = `Video ${order + 1}`;
  const title = (candidate.title || titleFromUrl(candidate.url, fallbackTitle) || fallbackTitle).slice(0, 200);
  const streams: GrabStream[] = [];
  const note = manifestNote(manifest);

  if (manifest && manifest.qualities.length > 1) {
    for (const variant of manifest.qualities) {
      streams.push({
        quality: normalizeQualityLabel(variant.quality, 'source'),
        container: manifest.container,
        bitrateKbps: variant.bandwidth ? Math.round(variant.bandwidth / 1000) : undefined,
        // Each rendition keeps its own playlist URL: that is what gets downloaded.
        url: variant.url || candidate.url,
        codecs: variant.codecs,
        kind: candidate.kind,
        sizeBytes:
          manifest.durationSeconds && variant.bandwidth
            ? Math.round((manifest.durationSeconds * variant.bandwidth) / 8)
            : manifest.sizeBytesEstimate,
        segments: manifest.segmentCount,
        durationSeconds: manifest.durationSeconds,
        encrypted: manifest.encrypted,
        live: manifest.live || undefined,
        note,
        pageUrl: candidate.pageUrl,
      });
    }
  } else {
    streams.push({
      quality: normalizeQualityLabel(manifest?.qualities[0]?.quality ?? candidate.quality ?? 'source', 'source'),
      container: manifest ? manifest.container : candidate.container,
      bitrateKbps: candidate.bitrateKbps,
      url: manifest?.qualities[0]?.url || candidate.url,
      kind: candidate.kind,
      sizeBytes: manifest?.sizeBytesEstimate ?? probed?.sizeBytes,
      segments: manifest?.segmentCount,
      durationSeconds: manifest?.durationSeconds,
      encrypted: manifest?.encrypted ?? false,
      live: manifest?.live || undefined,
      note,
      pageUrl: candidate.pageUrl,
    });
  }

  return { groupKey: groupKeyFor(candidate), draft: {
    title,
    pageUrl: candidate.pageUrl,
    posterUrl: candidate.posterUrl,
    orderHint: candidate.orderHint,
    foundOrder: order,
    streams,
  } };
}

/** Renditions of one video share a group key: same directory + same name family. */
export function groupKeyFor(candidate: SniffedCandidate): string {
  let path = candidate.url;
  try {
    path = new URL(candidate.url).pathname;
  } catch {
    // keep the raw string
  }
  const withoutExtension = path.replace(/\.[a-z0-9]{2,5}$/i, '');
  const directory = withoutExtension.replace(/\/[^/]*$/, '/').toLowerCase();
  const family = withoutExtension
    .replace(/[-_. ](?:\d{3,4}p|source|hd|sd|fhd|uhd|4k|2160|1440|1080|720|480|360|240)$/i, '')
    .replace(/[-_. ](?:hls|dash|master|playlist|media|video)$/i, '')
    .toLowerCase();
  // A candidate found on a crawled episode page belongs to that page only.
  const page = candidate.depth > 0 ? candidate.pageUrl : '';
  return page ? `${page}#${family}` : `${directory}${family}`;
}

/** Build one draft that covers everything found on a single crawled page. */
async function buildDraftForPage(
  candidates: SniffedCandidate[],
  pageTitle: string | undefined,
  pageImage: string | undefined,
  pageUrl: URL,
  order: number,
  cfg: GrabConfig,
  signal: AbortSignal | undefined,
  budget: Budget,
  trace: Trace,
): Promise<EpisodeDraft | null> {
  const streams: GrabStream[] = [];
  for (const candidate of candidates) {
    const manifest =
      candidate.kind === 'hls' || candidate.kind === 'dash' ? await readManifest(candidate, cfg, signal, budget, trace) : null;
    const probed = manifest ? undefined : await probeMedia(candidate.url, cfg, pageUrl, signal, budget, trace);
    if (probed && !probed.ok) continue;
    streams.push(...buildEpisodeDraft(candidate, manifest, order, probed).draft.streams);
  }
  if (streams.length === 0) return null;
  return {
    title: (pageTitle || titleFromUrl(pageUrl.pathname, pageUrl.hostname) || `Video ${order + 1}`).slice(0, 200),
    pageUrl: pageUrl.toString(),
    posterUrl: pageImage,
    orderHint: order + 1,
    foundOrder: order,
    streams: dedupeStreams(streams),
  };
}

function dedupeStreams(streams: GrabStream[]): GrabStream[] {
  const byKey = new Map<string, GrabStream>();
  for (const stream of streams) {
    const key = `${stream.quality}|${stream.container}|${stream.url}`;
    if (!byKey.has(key)) byKey.set(key, stream);
  }
  const ordered = [...byKey.values()].sort(
    (a, b) => heightOf(b) - heightOf(a) || (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0),
  );
  const open = ordered.filter((stream) => !stream.encrypted);
  // Encrypted renditions stay visible (one entry) when nothing else was found.
  return (open.length > 0 ? open : ordered.slice(0, 1)).slice(0, 8);
}

/** Ignore tracking noise so re-analyzing the same page reuses the stored series. */
export function normalizeCanonicalUrl(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  copy.search = '';
  copy.username = '';
  copy.password = '';
  copy.hostname = copy.hostname.toLowerCase().replace(/^www\./, '');
  copy.pathname = copy.pathname.replace(/\/+$/, '') || '/';
  return `${copy.protocol}//${copy.host}${copy.pathname}`;
}

function finalizeSeries(
  drafts: EpisodeDraft[],
  input: {
    url: URL;
    title: string;
    posterUrl?: string;
    synopsis?: string;
    diagnostics: string[];
    pageKind: 'html' | 'media';
    crawledPages?: string[];
  },
): ExtractedSeries {
  const episodes: ExtractedEpisode[] = drafts.map((draft, index) => {
    const duration = draft.streams.reduce((total, stream) => Math.max(total, stream.durationSeconds ?? 0), 0);
    const size = draft.streams.reduce((total, stream) => Math.max(total, stream.sizeBytes ?? 0), 0);
    return {
      index: index + 1,
      title: draft.title || `Video ${index + 1}`,
      url: draft.pageUrl || draft.streams[0]?.url || input.url.toString(),
      durationSeconds: duration > 0 ? duration : undefined,
      thumbnailUrl: draft.posterUrl,
      streams: draft.streams.map(({ pageUrl, ...stream }) => {
        void pageUrl;
        return stream;
      }),
      metadata: {
        grabbed: true,
        pageUrl: draft.pageUrl,
        streamUrls: draft.streams.map((stream) => stream.url),
        encrypted: draft.streams.length > 0 && draft.streams.every((stream) => stream.encrypted === true),
        // A live playlist has no end: there is no finished file to store yet.
        live: allStreamsLive(draft) || undefined,
        sizeBytes: size > 0 ? size : undefined,
      },
    };
  });

  return {
    sourceKey: 'http-sniff',
    title: (input.title || input.url.hostname).slice(0, 200),
    synopsis: input.synopsis,
    posterUrl: input.posterUrl,
    canonicalUrl: `grab:${normalizeCanonicalUrl(input.url)}`,
    sourceUrl: input.url.toString(),
    episodes,
    metadata: {
      grabbed: true,
      pageKind: input.pageKind,
      videoCount: episodes.length,
      encryptedCount: episodes.filter((episode) => episode.metadata?.encrypted === true).length,
      diagnostics: input.diagnostics.slice(0, 60),
      crawledPages: input.crawledPages ?? [],
      generatedBy: 'HttpSniffExtractor',
    },
  };
}
