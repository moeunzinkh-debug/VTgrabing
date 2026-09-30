import { badRequest, internalError } from '../core/errors';
import type { GrabConfig } from './config';
import { isErrorPageContentType } from './media-types';
import { type Budget, openMediaStream } from './net';

/**
 * Ordered, resumable, memory-bounded byte transfer - the actual downloading.
 *
 * `chunkedDownload` cuts one large progressive file into `Range` requests, so a
 * dropped connection resumes at the last finished chunk instead of starting over
 * and peak memory stays at a handful of chunks.
 *
 * `segmentDownload` walks an HLS/DASH segment list in parallel but yields strictly
 * in playlist order, which is what turns the concatenation into a playable file.
 *
 * Both are async generators, so the R2 multipart writer downstream applies back
 * pressure: a slow bucket slows the network fetches instead of filling memory.
 */

export interface DownloadProgressUpdate {
  bytes: number;
  totalBytes: number | null;
  /** 0..100 when computable. */
  percent?: number;
  note?: string;
}

export interface SegmentInput {
  url: string;
  /** `#EXT-X-BYTERANGE` style slice of the referenced resource. */
  byteRange?: { start: number; length: number };
}

export interface StreamOptions {
  cfg: GrabConfig;
  headers?: Record<string, string>;
  budget: Budget;
  signal?: AbortSignal;
  /** Hard cap per object, defaults to `GRAB_MAX_VIDEO_BYTES`. */
  maxBytes?: number;
  /**
   * Set when the bytes are the media file itself (parts, segments, init segment): the
   * response is then refused if the host answered with an HTML/text document instead of
   * media. Manifest reads leave this off - a playlist is legitimately text.
   */
  mediaContent?: boolean;
  onProgress?: (update: DownloadProgressUpdate) => void | Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Fatal errors are not retried: a refusal stays a refusal. */
function isFatal(message: string): boolean {
  return /Refusing to fetch|Only http and https|not a usable URL|larger than the|budget \(GRAB_MAX_VIDEO_BYTES\)|timed out/i.test(
    message,
  );
}

/** Fetch one resource (optionally a byte range) with a small retry ladder. */
export async function fetchRange(
  url: string,
  options: StreamOptions,
  range?: { start: number; end: number },
): Promise<Uint8Array> {
  const limit = range ? range.end - range.start + 1 : (options.maxBytes ?? options.cfg.maxVideoBytes);
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const opened = await openMediaStream(
        url,
        options.cfg,
        { method: 'GET', headers: options.headers, timeoutMs: options.cfg.mediaTimeoutMs, signal: options.signal },
        options.budget,
        range,
      );
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await opened.reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        size += value.byteLength;
        if (size > limit) {
          await opened.reader.cancel('over budget').catch(() => undefined);
          throw badRequest(
            `Response from ${new URL(url).host} exceeded the ${limit} byte limit (GRAB_MAX_VIDEO_BYTES / GRAB_CHUNK_BYTES)`,
          );
        }
        chunks.push(value);
      }
      let data = concat(chunks, size);

      if (size === 0) {
        // The host accepted the request and sent nothing. Retrying is fine, but a
        // zero-length answer must never be re-requested recursively.
        throw badRequest(
          `${new URL(url).host} returned no bytes for ${range ? `range bytes=${range.start}-${range.end}` : url}`,
          { url },
        );
      }

      if (range && size < limit && attempt < 3) {
        // Short chunk: re-request the missing tail so a part is never truncated.
        const tail = await fetchRange(url, options, { start: range.start + size, end: range.end });
        const joined = new Uint8Array(size + tail.byteLength);
        joined.set(data, 0);
        joined.set(tail, size);
        data = joined;
      }
      return data;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (isFatal(message)) throw error;
      if (attempt < 3) await sleep(300 * 2 ** (attempt - 1), options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Download of ${url} failed`);
}

/**
 * Keeps at most `concurrency` fetches in flight and hands finished results to the
 * consumer in request order. Errors surface at the position that failed.
 */
class PrefetchPipeline {
  private buffer = new Map<number, Uint8Array>();
  private inflight = new Map<number, Promise<void>>();
  private error: unknown = null;
  private next = 0;
  private index = 0;

  constructor(
    private readonly count: number,
    private readonly concurrency: number,
    private readonly fetchOne: (index: number) => Promise<Uint8Array>,
  ) {}

  get failures(): unknown {
    return this.error;
  }

  private schedule(): void {
    while (this.error === null && this.next < this.count && this.inflight.size < this.concurrency) {
      const slot = this.next;
      this.next += 1;
      const promise = (async () => {
        try {
          const bytes = await this.fetchOne(slot);
          this.buffer.set(slot, bytes);
        } catch (error) {
          this.error ??= error;
        } finally {
          this.inflight.delete(slot);
        }
      })();
      this.inflight.set(slot, promise);
    }
  }

  /** Next ordered payload, or `null` when everything has been delivered. */
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      this.schedule();
      if (this.buffer.has(this.index)) {
        const bytes = this.buffer.get(this.index)!;
        this.buffer.delete(this.index);
        this.index += 1;
        return bytes;
      }
      if (this.index >= this.count) return null;
      if (this.error !== null) throw this.error;
      if (this.inflight.size === 0) {
        throw internalError(`Download stalled after ${this.index} part(s) with nothing in flight`);
      }
      await Promise.race([...this.inflight.values()]);
    }
  }

  /** Cancel pending work: called when the consumer stops early. */
  cancel(): void {
    this.buffer.clear();
    this.inflight.clear();
  }
}

export interface ResourceInfo {
  totalBytes: number | null;
  contentType: string;
  acceptsRanges: boolean;
  status: number;
}

/** Probe a media resource with `GET Range: bytes=0-0` (HEAD fallback). */
export async function inspectResource(url: string, options: StreamOptions): Promise<ResourceInfo> {
  try {
    const opened = await openMediaStream(
      url,
      options.cfg,
      {
        method: 'GET',
        headers: { ...(options.headers ?? {}), range: 'bytes=0-0' },
        timeoutMs: options.cfg.pageTimeoutMs,
        signal: options.signal,
      },
      options.budget,
    );
    let totalBytes = opened.totalBytes;
    const contentRange = opened.response.headers.get('content-range');
    const match = contentRange ? /\/(\d+)\s*$/.exec(contentRange) : null;
    if (match?.[1]) totalBytes = Number.parseInt(match[1], 10);
    void opened.reader.cancel().catch(() => undefined);
    if (isErrorPageContentType(opened.contentType)) {
      throw badRequest(
        `${new URL(url).host} answered with ${opened.contentType} (HTTP ${opened.response.status}) instead of a media file. ` +
          `That is usually the page URL rather than the video URL - analyze the page and pick a stream from it.`,
        { url, contentType: opened.contentType },
      );
    }
    return {
      totalBytes,
      contentType: opened.contentType,
      acceptsRanges: opened.acceptsRanges || opened.response.status === 206,
      status: opened.response.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Refusing to fetch|Only http and https|not a usable URL/i.test(message)) throw error;
    try {
      const opened = await openMediaStream(
        url,
        options.cfg,
        { method: 'HEAD', headers: options.headers, timeoutMs: options.cfg.pageTimeoutMs, signal: options.signal },
        options.budget,
      );
      void opened.reader.cancel().catch(() => undefined);
      if (isErrorPageContentType(opened.contentType)) {
        throw badRequest(
          `${new URL(url).host} answered with ${opened.contentType} (HTTP ${opened.response.status}) instead of a media file.`,
          { url, contentType: opened.contentType },
        );
      }
      return {
        totalBytes: opened.totalBytes ?? opened.contentLength,
        contentType: opened.contentType,
        acceptsRanges: false,
        status: opened.response.status,
      };
    } catch (headError) {
      throw new Error(`Media host refused the request (${message || (headError as Error).message})`);
    }
  }
}

/** Progressive single file: Range chunked when supported, one stream otherwise. */
export async function* chunkedDownload(
  url: string,
  info: ResourceInfo,
  options: StreamOptions,
): AsyncGenerator<Uint8Array, void, void> {
  const maxBytes = options.maxBytes ?? options.cfg.maxVideoBytes;
  const total = info.totalBytes;
  if (total !== null && total > maxBytes) {
    throw badRequest(
      `This file is ${(total / 1024 / 1024).toFixed(1)} MiB, above the GRAB_MAX_VIDEO_BYTES budget of ${(maxBytes / 1024 / 1024).toFixed(0)} MiB`,
      { totalBytes: total, maxBytes },
    );
  }

  if (!info.acceptsRanges || total === null) {
    const opened = await openMediaStream(
      url,
      options.cfg,
      { method: 'GET', headers: options.headers, timeoutMs: options.cfg.mediaTimeoutMs, signal: options.signal },
      options.budget,
    );
    if (isErrorPageContentType(opened.contentType)) {
      // A page (or an error document) masquerading as a video file: refuse it here so
      // it is never stored under a .mp4 name.
      await opened.reader.cancel('not media').catch(() => undefined);
      throw badRequest(
        `${new URL(url).host} served ${opened.contentType || 'an unknown type'} (HTTP ${opened.response.status}) instead of a media file, so this URL is not a video.`,
      );
    }
    let seen = 0;
    try {
      for (;;) {
        const { done, value } = await opened.reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        seen += value.byteLength;
        if (seen > maxBytes) {
          await opened.reader.cancel('over budget').catch(() => undefined);
          throw badRequest(`Download exceeded the ${maxBytes} byte budget (GRAB_MAX_VIDEO_BYTES)`);
        }
        await options.onProgress?.({
          bytes: seen,
          totalBytes: total,
          percent: total ? Math.min(99, Math.round((seen / total) * 100)) : undefined,
        });
        yield value;
      }
    } finally {
      try {
        opened.reader.releaseLock();
      } catch {
        // Already released by the cancel above.
      }
    }
    if (total !== null && seen !== total) {
      // Without Range support we cannot resume, but we can still refuse to present a
      // truncated body as a finished file.
      throw badRequest(`Incomplete download: received ${seen} of ${total} advertised bytes (the connection ended early)`, {
        received: seen,
        advertised: total,
      });
    }
    return;
  }

  const chunkSize = options.cfg.chunkBytes;
  const partCount = Math.max(1, Math.ceil(total / chunkSize));
  // ~64 MiB of in-flight data at most, whatever the chunk size is.
  const concurrency = Math.max(1, Math.min(4, Math.floor((64 * 1024 * 1024) / chunkSize)));
  const pipeline = new PrefetchPipeline(partCount, concurrency, (index) => {
    const start = index * chunkSize;
    const end = Math.min(total - 1, start + chunkSize - 1);
    return fetchRange(url, options, { start, end });
  });

  let bytes = 0;
  let parts = 0;
  for (;;) {
    const chunk = await pipeline.read();
    if (chunk === null) break;
    bytes += chunk.byteLength;
    parts += 1;
    await options.onProgress?.({
      bytes,
      totalBytes: total,
      percent: Math.min(99, Math.round((parts / partCount) * 100)),
      note: `part ${parts}/${partCount}`,
    });
    yield chunk;
  }
  if (bytes !== total) {
    // A host that lies about Content-Length must not produce a silently short file.
    throw badRequest(
      `Incomplete download: received ${bytes} of ${total} advertised bytes after ${parts}/${partCount} part(s)`,
      { received: bytes, advertised: total },
    );
  }
}

/** HLS/DASH: concatenate the init segment (when any) plus every media segment. */
export async function* segmentDownload(
  segments: SegmentInput[],
  options: StreamOptions & { initSegment?: Uint8Array; concurrency?: number },
): AsyncGenerator<Uint8Array, void, void> {
  if (segments.length === 0) throw badRequest('The playlist contains no segments');
  const maxBytes = options.maxBytes ?? options.cfg.maxVideoBytes;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? options.cfg.fetchConcurrency, segments.length));
  const pipeline = new PrefetchPipeline(segments.length, concurrency, (index) => {
    const segment = segments[index];
    const range = segment.byteRange
      ? { start: segment.byteRange.start, end: segment.byteRange.start + segment.byteRange.length - 1 }
      : undefined;
    return fetchRange(segment.url, options, range);
  });

  let bytes = 0;
  let parts = 0;
  if (options.initSegment && options.initSegment.byteLength > 0) {
    bytes += options.initSegment.byteLength;
    yield options.initSegment;
  }
  for (;;) {
    const chunk = await pipeline.read();
    if (chunk === null) break;
    bytes += chunk.byteLength;
    parts += 1;
    if (bytes > maxBytes) {
      pipeline.cancel();
      throw badRequest(`Playlist exceeded the ${maxBytes} byte budget (GRAB_MAX_VIDEO_BYTES)`);
    }
    await options.onProgress?.({
      bytes,
      totalBytes: null,
      percent: Math.min(99, Math.round((parts / segments.length) * 100)),
      note: `segment ${parts}/${segments.length}`,
    });
    yield chunk;
  }
}

export { sleep };
