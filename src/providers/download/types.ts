import type { Env } from '../../env';
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
  quality: string;
  container: string;
  objectKey: string;
  filename: string;
  /**
   * Origin (scheme + host) the external service must call back on.
   * Overridden by `DOWNLOAD_CALLBACK_URL` when set.
   */
  callbackOrigin: string;
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
  readonly kind: 'mock' | 'remote';
  isConfigured(env: Env): boolean;
  describe(env: Env): ProviderDescriptor;
  start(request: DownloadRequest, env: Env): Promise<DownloadResult>;
  /** Poll a deferred job. Required for `kind: 'remote'` providers. */
  status?(providerRef: string, env: Env): Promise<RemoteJobStatus>;
  /** Best-effort cancellation of a deferred job. */
  cancel?(providerRef: string, env: Env): Promise<void>;
}
