import { z } from 'zod';
import { notConfigured } from '../../core/errors';
import type { Env } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import { buildCallbackUrl, signRequest, signedCallbackUrl } from '../signature';
import type { DownloadProvider, DownloadRequest, DownloadResult, RemoteJobStatus } from './types';

/**
 * Production download provider.
 *
 * Cloudflare Workers cannot perform the work a real media grabber needs:
 * there is no filesystem, no child processes (no ffmpeg/yt-dlp), a ~128 MB memory
 * ceiling, and per-request CPU limits. VTGrab therefore delegates the heavy
 * lifting to an **external service the operator is authorized to use** and keeps
 * the orchestration, storage and bookkeeping inside the Worker:
 *
 *   1. Worker  -> POST {DOWNLOAD_SERVICE_URL}/v1/downloads          (signed, Bearer)
 *   2. Service -> PUT  /api/internal/provider/callback/{jobItemId}  (signed, HMAC)
 *      ...or the Worker polls GET /v1/downloads/{providerJobId} until `ready`
 *      and then streams `downloadUrl` straight into R2.
 *
 * Both paths converge on the same code (`completeJobItemWithStream`), so the
 * behaviour is identical once the external service answers.
 */

export const REMOTE_TIMEOUT_MS = 20_000;
/** Default lifetime of a callback URL handed to the download service. */
export const CALLBACK_TTL_SECONDS = 6 * 60 * 60;

const submitResponseSchema = z.object({
  providerJobId: z.string().min(1).max(256),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']).default('queued'),
  downloadUrl: z.string().url().optional(),
  bytes: z.number().int().nonnegative().optional(),
  contentType: z.string().max(255).optional(),
  error: z.string().max(2000).optional(),
});

const statusResponseSchema = z.object({
  status: z.enum(['queued', 'running', 'ready', 'failed', 'cancelled']),
  progress: z.number().min(0).max(100).optional(),
  downloadUrl: z.string().url().optional(),
  bytes: z.number().int().nonnegative().optional(),
  contentType: z.string().max(255).optional(),
  error: z.string().max(2000).optional(),
});

function serviceUrl(env: Env): URL | null {
  const raw = env.DOWNLOAD_SERVICE_URL;
  if (!raw) return null;
  try {
    // Always keep a trailing slash so relative paths append instead of replace.
    return new URL(`${new URL(raw).origin}${new URL(raw).pathname.replace(/\/+$/, '')}/`);
  } catch {
    return null;
  }
}

function requireServiceUrl(env: Env): URL {
  const url = serviceUrl(env);
  if (!url) {
    throw notConfigured(
      'DOWNLOAD_SERVICE_URL is not configured, so no authorized download provider is available.',
    );
  }
  return url;
}

async function signedHeaders(env: Env, body: string, timestamp: number): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'vtgrab-worker/1.0',
  };
  if (env.DOWNLOAD_SERVICE_TOKEN) {
    headers.authorization = `Bearer ${env.DOWNLOAD_SERVICE_TOKEN}`;
  }
  const secret = env.DOWNLOAD_CALLBACK_SECRET ?? env.DOWNLOAD_SERVICE_TOKEN;
  if (secret) {
    Object.assign(headers, await signRequest(secret, timestamp, body));
  }
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = REMOTE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Build the outbound submit request (exported so tests can assert the wire format). */
export async function buildSubmitRequest(
  request: DownloadRequest,
  env: Env,
  now = Date.now(),
): Promise<{ url: string; init: RequestInit }> {
  const base = requireServiceUrl(env);
  const url = new URL('v1/downloads', base);
  const expiresAt = Math.floor(now / 1000) + CALLBACK_TTL_SECONDS;
  const callbackUrl = await buildCallback(request, env, expiresAt);

  const body = JSON.stringify({
    jobItemId: request.jobItemId,
    jobId: request.jobId,
    callbackUrl,
    callbackMethod: 'PUT',
    callbackHeaders: env.DOWNLOAD_CALLBACK_SECRET
      ? { 'content-type': 'application/octet-stream' }
      : {},
    objectKey: request.objectKey,
    quality: request.quality,
    container: request.container,
    series: { id: request.seriesId, title: request.seriesTitle },
    episode: {
      id: request.episodeId,
      index: request.episodeIndex,
      title: request.episodeTitle,
      url: request.sourceUrl,
      streamUrl: request.streamUrl,
    },
  });

  return { url: url.toString(), init: { method: 'POST', body, headers: await signedHeaders(env, body, Math.floor(now / 1000)) } };
}

async function buildCallback(request: DownloadRequest, env: Env, expiresAt: number): Promise<string> {
  if (!env.DOWNLOAD_CALLBACK_URL && !request.callbackOrigin) {
    throw notConfigured(
      'Set DOWNLOAD_CALLBACK_URL (or PUBLIC_BASE_URL) so the download service can reach this Worker.',
    );
  }
  const secret = env.DOWNLOAD_CALLBACK_SECRET;
  if (!secret) {
    const { url } = buildCallbackUrl(env, request.callbackOrigin, request.jobItemId, expiresAt);
    return url;
  }
  return signedCallbackUrl(env, request.callbackOrigin, request.jobItemId, expiresAt, secret);
}

/** GET an object URL exposed by the download service (Bearer + HMAC signed). */
export async function fetchRemoteObject(
  downloadUrl: string,
  env: Env,
): Promise<{ stream: ReadableStream<Uint8Array>; contentLength?: number; contentType: string }> {
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = await signedHeaders(env, downloadUrl, timestamp);
  const getHeaders: Record<string, string> = { accept: '*/*' };
  if (headers.authorization) getHeaders.authorization = headers.authorization;
  if (headers['x-vtgrab-signature']) getHeaders['x-vtgrab-signature'] = headers['x-vtgrab-signature'];
  if (headers['x-vtgrab-timestamp']) getHeaders['x-vtgrab-timestamp'] = headers['x-vtgrab-timestamp'];
  const response = await fetchWithTimeout(downloadUrl, { method: 'GET', headers: getHeaders });
  if (!response.ok || !response.body) {
    throw new Error(`Download service object fetch failed with ${response.status}`);
  }
  const contentLengthHeader = response.headers.get('content-length');
  return {
    stream: response.body,
    contentLength: contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined,
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}

export class RemoteDownloadProvider implements DownloadProvider {
  readonly key = 'remote';
  readonly label = 'Authorized remote download service';
  readonly kind = 'remote' as const;

  isConfigured(env: Env): boolean {
    return Boolean(serviceUrl(env));
  }

  async start(request: DownloadRequest, env: Env): Promise<DownloadResult> {
    const { url, init } = await buildSubmitRequest(request, env);
    const response = await fetchWithTimeout(url, init);
    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Download service rejected the job with ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
      );
    }
    const payload = submitResponseSchema.parse(await response.json());

    if (payload.status === 'failed') {
      throw new Error(payload.error ?? 'Download service reported a failure');
    }

    if (payload.status === 'ready' && payload.downloadUrl) {
      const object = await fetchRemoteObject(payload.downloadUrl, env);
      return {
        kind: 'stream',
        stream: object.stream,
        contentLength: payload.bytes ?? object.contentLength,
        contentType: payload.contentType ?? object.contentType,
      };
    }

    return {
      kind: 'deferred',
      providerRef: payload.providerJobId,
      note: 'Queued on the authorized download service; completion arrives by callback or poll.',
    };
  }

  async status(providerRef: string, env: Env): Promise<RemoteJobStatus> {
    const base = requireServiceUrl(env);
    const url = new URL(`v1/downloads/${encodeURIComponent(providerRef)}`, base);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: await signedHeaders(env, '', timestamp),
    });
    if (!response.ok) {
      throw new Error(`Download service status lookup failed with ${response.status}`);
    }
    return statusResponseSchema.parse(await response.json());
  }

  async cancel(providerRef: string, env: Env): Promise<void> {
    const base = requireServiceUrl(env);
    const url = new URL(`v1/downloads/${encodeURIComponent(providerRef)}`, base);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetchWithTimeout(url.toString(), {
      method: 'DELETE',
      headers: await signedHeaders(env, '', timestamp),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Download service cancel failed with ${response.status}`);
    }
  }

  describe(env: Env): ProviderDescriptor {
    const configured = this.isConfigured(env);
    return {
      key: this.key,
      label: this.label,
      kind: 'remote',
      available: configured,
      configured,
      reason: configured
        ? `Delegates to ${serviceUrl(env)!.origin} and stores the result in R2.`
        : 'Set DOWNLOAD_SERVICE_URL + DOWNLOAD_SERVICE_TOKEN (secret) to enable real downloads.',
      docs: 'README.md#authorized-download-service',
    };
  }
}
