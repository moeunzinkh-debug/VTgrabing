/**
 * Domain types shared by the Cloudflare Worker (server) and the Vite frontend.
 * This module must stay framework free (no `cloudflare:*` imports, no DOM types)
 * so it can be imported from both bundles.
 */

export const JOB_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'partial',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_ITEM_STATUSES = [
  'pending',
  'downloading',
  'completed',
  'failed',
  'cancelled',
  'skipped',
] as const;
export type JobItemStatus = (typeof JOB_ITEM_STATUSES)[number];

export interface StreamInfo {
  /** Human readable quality label, e.g. "1080p". */
  quality: string;
  /** Container/extension without the dot, e.g. "mp4". */
  container: string;
  /** Optional advertised bitrate. */
  bitrateKbps?: number;
  /** Direct media URL when the source exposes one. */
  url?: string;
  /** Codec string when known. */
  codecs?: string;
  /**
   * How the bytes have to be fetched. Only the real grabber sets this:
   * `progressive` is one file, `hls`/`dash` are segment lists that get concatenated.
   */
  kind?: 'progressive' | 'hls' | 'dash';
  /** Size in bytes when the host advertised one (Content-Length / manifest math). */
  sizeBytes?: number;
  /** Segment count for an adaptive stream. */
  segments?: number;
  /** True when the playlist is still running (no `#EXT-X-ENDLIST`): not a file yet. */
  live?: boolean;
  /** Duration in seconds, read from the manifest. */
  durationSeconds?: number;
  /**
   * True when the manifest declares encryption (`#EXT-X-KEY`, DRM key systems).
   * VTGrab refuses to download those; the flag exists so the UI can say why.
   */
  encrypted?: boolean;
  /** Human readable caveat (why something is not grabbable, DRM, live, ...). */
  note?: string;
}

export interface SeriesRecord {
  id: string;
  sourceKey: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  synopsis: string | null;
  posterUrl: string | null;
  episodeCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeRecord {
  id: string;
  seriesId: string;
  episodeIndex: number;
  title: string;
  sourceUrl: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  streams: StreamInfo[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type SelectionMode = 'all' | 'ids' | 'range';

export interface SelectionDescriptor {
  mode: SelectionMode;
  /** Only for `mode: 'ids'`. */
  episodeIds?: string[];
  /** Only for `mode: 'range'` (1-based, inclusive). */
  range?: { from: number; to: number };
}

export interface JobOptions {
  quality: string;
  container: string;
  concurrency: number;
  prefix: string;
  /** Optional explicit provider key, otherwise resolved from configuration. */
  provider?: string;
}

export interface JobRecord {
  id: string;
  seriesId: string;
  status: JobStatus;
  selection: SelectionDescriptor;
  options: JobOptions;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  cancelledItems: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobItemRecord {
  id: string;
  jobId: string;
  episodeId: string;
  seriesId: string;
  position: number;
  status: JobItemStatus;
  progress: number;
  attempts: number;
  quality: string;
  container: string;
  objectKey: string;
  bytes: number;
  error: string | null;
  fileId: string | null;
  provider: string | null;
  providerRef: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  jobId: string | null;
  jobItemId: string | null;
  seriesId: string | null;
  episodeId: string | null;
  bucket: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  etag: string | null;
  checksumSha256: string | null;
  quality: string | null;
  container: string | null;
  durationSeconds: number | null;
  provider: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type JobEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface JobEventRecord {
  id: number;
  jobId: string | null;
  jobItemId: string | null;
  level: JobEventLevel;
  message: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

/** A job item joined with the episode it downloads, used by list/detail views. */
export interface JobItemView extends JobItemRecord {
  episodeIndex: number;
  episodeTitle: string;
  episodeUrl: string;
  filename: string;
}

export interface JobDetail {
  job: JobRecord;
  items: JobItemView[];
  series: Pick<SeriesRecord, 'id' | 'title' | 'sourceKey' | 'sourceUrl' | 'posterUrl'> | null;
}

export interface JobListItem extends JobRecord {
  seriesTitle: string | null;
  bytes: number;
}

export interface SeriesDetail {
  series: SeriesRecord;
  episodes: EpisodeRecord[];
}

/** Status of one configured extractor / download provider. */
export interface ProviderDescriptor {
  key: string;
  label: string;
  /** `http` = the real grabber, `mock` = synthetic dev data, the rest are integrations. */
  kind: 'mock' | 'authorized' | 'remote' | 'http';
  available: boolean;
  configured: boolean;
  reason?: string;
  docs?: string;
}

export interface SystemStatus {
  environment: string;
  time: string;
  bindings: {
    database: boolean;
    bucket: boolean;
    queue: boolean;
  };
  extractors: ProviderDescriptor[];
  downloadProviders: ProviderDescriptor[];
  limits: {
    maxAttempts: number;
    defaultQuality: string;
    defaultContainer: string;
    defaultConcurrency: number;
    queuePushBatchSize: number;
  };
  /** Configuration of the real link grabber (`src/grab/*`). */
  grab?: {
    enabled: boolean;
    allowedHosts: string[];
    deniedHosts: string[];
    allowPrivateHosts: boolean;
    maxVideos: number;
    maxVideoBytes: number;
    chunkBytes: number;
    probe: boolean;
    followEmbeds: boolean;
    crawl: boolean;
    maxCrawlPages: number;
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
