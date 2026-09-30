import type { Env } from '../../env';
import type { DownloadProgressUpdate } from '../../grab/fetch-stream';
import type { ProviderDescriptor } from '../../shared/types';

export interface DownloadRequest {
  jobItemId: string;
  jobId: string;
  seriesId: string;
  seriesTitle: string;
  episodeId: string;
  episodeIndex: number;
  episodeTitle: string;
  /** Web page / manifest URL of the episode. */
  sourceUrl: string;
  /** Direct stream URL for the requested quality, when the source exposes one. */
  streamUrl?: string;
  /** How that URL has to be fetched (set by the real grabber). */
  streamKind?: 'progressive' | 'hls' | 'dash';
  /** True when the recorded manifest declared encryption/DRM. */
  streamEncrypted?: boolean;
  quality: string;
  container: string;
  objectKey: string;
  filename: string;
  /**
   * Origin (scheme + host) the external service must call back on.
   * Overridden by `DOWNLOAD_CALLBACK_URL` when set.
   */
  callbackOrigin: string;
  /**
   * Live progress hook for providers that stream inside the Worker. It is a
   * function on purpose (never serialized): HTTP providers simply ignore it.
   */
  onProgress?: (update: DownloadProgressUpdate) => void | Promise<void>;
}

/**
 * `stream`   -> bytes are available right now, the worker writes them to R2.
 * `deferred` -> the work was handed to an external service; completion arrives
 *               through the signed callback endpoint or a `status()` poll.
 */
export type DownloadResult =
  | {
      kind: 'stream';
      stream: ReadableStream<Uint8Array>;
      contentLength?: number;
      contentType: string;
      /** Present when the provider can hash the full payload (small objects). */
      checksumSha256?: string;
      /**
       * Actual container of the bytes. The real grabber knows only after reading
       * the manifest (an HLS playlist can hold TS *or* fMP4 segments), so the
       * orchestrator renames the object key when this differs from what was asked.
       */
      container?: string;
      /** Actual quality label, e.g. the HLS variant that was selected. */
      quality?: string;
    }
  | {
      kind: 'deferred';
      providerRef: string;
      note?: string;
    };

export interface RemoteJobStatus {
  status: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
  progress?: number;
  error?: string;
  /** URL the worker can stream the finished object from. */
  downloadUrl?: string;
  bytes?: number;
  contentType?: string;
}

export interface DownloadProvider {
  readonly key: string;
  readonly label: string;
  readonly kind: 'mock' | 'remote' | 'http';
  isConfigured(env: Env): boolean;
  describe(env: Env): ProviderDescriptor;
  start(request: DownloadRequest, env: Env): Promise<DownloadResult>;
  /** Poll a deferred job. Required for `kind: 'remote'` providers. */
  status?(providerRef: string, env: Env): Promise<RemoteJobStatus>;
  /** Best-effort cancellation of a deferred job. */
  cancel?(providerRef: string, env: Env): Promise<void>;
}
