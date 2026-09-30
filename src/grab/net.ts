import { badRequest, internalError } from '../core/errors';
import type { GrabConfig } from './config';
import { safeUrl } from './guard';

/**
 * Guarded HTTP client used by every outbound grabber request.
 *
 * - redirects are followed manually so each hop goes through the same SSRF check
 * - a single abort controller bounds the whole chain by wall clock
 * - response bodies are read with a byte budget (a hostile server cannot make us
 *   buffer 2 GiB of HTML in a 128 MB isolate)
 * - a per-invocation sub-request counter keeps queue consumers inside the Cloudflare
 *   limits instead of being killed mid download
 */

export class Budget {
  private used = 0;
  constructor(private readonly limit: number) {}

  get remaining(): number {
    return this.limit - this.used;
  }

  get used_(): number {
    return this.used;
  }

  take(count = 1): void {
    this.used += count;
    if (this.used > this.limit) {
      throw internalError(
        `Grab budget of ${this.limit} sub-requests exhausted (Workers cap requests per invocation; ` +
          `raise GRAB_MAX_SUBREQUESTS or lower GRAB_CHUNK_BYTES / use larger segments).`,
      );
    }
  }
}

export interface GrabResponse {
  response: Response;
  url: URL;
  status: number;
}

export interface GrabInit {
  method?: string;
  headers?: Record<string, string>;
  /** Wall clock budget for this logical request including redirects. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Only accept these response codes as "success" (default 2xx, plus 206). */
  acceptedStatuses?: number[];
}

/** Follow redirects by hand so every hop is screened by the same host policy. */
export async function grabFetch(
  input: string | URL,
  cfg: GrabConfig,
  init: GrabInit = {},
  budget = new Budget(cfg.maxSubrequests),
): Promise<GrabResponse> {
  const method = (init.method ?? 'GET').toUpperCase();
  const timeoutMs = init.timeoutMs ?? cfg.pageTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(init.signal?.reason ?? new Error('aborted'));
  init.signal?.addEventListener('abort', onAbort, { once: true });

  let next = safeUrl(input, cfg).url;
  let hops = 0;
  try {
    for (;;) {
      budget.take();
      let response: Response;
      try {
        response = await fetch(next.toString(), {
          method,
          headers: init.headers,
          redirect: 'manual',
          signal: controller.signal,
          cf: { cacheTtl: 0 },
        } as RequestInit);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw badRequest(`Could not reach ${next.host}: ${reason}`, { url: next.toString() });
      }

      const location = response.headers.get('location');
      if (location && response.status >= 300 && response.status < 400) {
        if (hops >= cfg.maxRedirects) {
          throw badRequest(`Too many redirects (>${cfg.maxRedirects}) while fetching ${next.toString()}`);
        }
        hops += 1;
        let target: URL;
        try {
          target = new URL(location, next);
        } catch {
          throw badRequest(`Invalid redirect target "${location.slice(0, 200)}"`);
        }
        next = safeUrl(target, cfg).url;
        // Cancel the redirect body, then retry against the new location.
        void response.body?.cancel().catch(() => undefined);
        continue;
      }

      const accepted = init.acceptedStatuses ?? [200, 206];
      if (!accepted.includes(response.status)) {
        const hint =
          response.status === 401 || response.status === 403
            ? ' - the resource requires authentication or blocks hotlinking, and VTGrab deliberately sends no cookies or tokens'
            : response.status === 404
              ? ' - the URL does not exist'
              : '';
        throw badRequest(
          `Fetch of ${next.toString()} failed with HTTP ${response.status}${hint}`,
          { url: next.toString(), status: response.status },
        );
      }
      return { response, url: next, status: response.status };
    }
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

export interface LimitedText {
  text: string;
  bytes: number;
  truncated: boolean;
  contentType: string;
  finalUrl: URL;
}

/** Read a response body to a string, never exceeding `maxBytes`. */
export async function readTextLimited(
  response: Response,
  maxBytes: number,
  finalUrl: URL,
): Promise<LimitedText> {
  const { bytes, truncated } = await readBodyLimited(response, maxBytes);
  const text = new TextDecoder().decode(bytes);
  return {
    text,
    bytes: bytes.byteLength,
    truncated,
    contentType: response.headers.get('content-type') ?? '',
    finalUrl,
  };
}

export async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (size + value.byteLength > maxBytes) {
        const room = maxBytes - size;
        if (room > 0) chunks.push(value.subarray(0, room));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  const out = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, truncated };
}

/** Open a media body and hand the caller the reader plus the advertised size. */
export async function openMediaStream(
  url: string | URL,
  cfg: GrabConfig,
  init: GrabInit,
  budget: Budget,
  range?: { start: number; end: number },
): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array>; contentLength: number | null; contentType: string; totalBytes: number | null; acceptsRanges: boolean }> {
  // A HEAD response (and a 206 that carries no bytes) legitimately has no body, so the
  // reader is empty rather than an error: the caller decides whether zero bytes is ok.
  const headers = { ...(init.headers ?? {}) };
  if (range) headers.range = `bytes=${range.start}-${range.end}`;
  const { response } = await grabFetch(url, cfg, { ...init, headers }, budget);

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
  const acceptRanges = (response.headers.get('accept-ranges') ?? '').toLowerCase();
  const contentRange = response.headers.get('content-range');

  let totalBytes: number | null = null;
  if (contentRange) {
    const match = /\/(\d+|\*)$/.exec(contentRange);
    if (match && match[1] !== '*') totalBytes = Number.parseInt(match[1], 10);
  } else if (response.status === 200 && Number.isFinite(contentLength ?? Number.NaN)) {
    totalBytes = contentLength;
  }

  return {
    response,
    reader: response.body ? response.body.getReader() : new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }).getReader(),
    contentLength: Number.isFinite(contentLength ?? Number.NaN) ? contentLength : null,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    totalBytes,
    acceptsRanges: acceptRanges === 'bytes' || response.status === 206,
  };
}
