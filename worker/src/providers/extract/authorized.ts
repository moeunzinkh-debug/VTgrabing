import { z } from 'zod';
import { notConfigured } from '../../core/errors';
import type { Env } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import type { ExtractedEpisode, ExtractedSeries, SourceExtractor } from './types';

/**
 * Contract of the **authorized** catalog API.
 *
 * VTGrab ships no scraper and performs no DRM circumvention. In production the
 * metadata is fetched from a service the operator is authorized to call (their own
 * catalog, a licensed partner API, an internal CMS, ...). Point
 * `SOURCE_API_BASE_URL` + `SOURCE_API_TOKEN` at that service and the rest of the
 * pipeline works unchanged.
 *
 *   GET {SOURCE_API_BASE_URL}/v1/series?url={seriesUrl}
 *   Authorization: Bearer {SOURCE_API_TOKEN}
 *   Accept: application/json
 *
 *   200 -> AuthorizedSeriesResponse (schema below)
 */
const streamSchema = z.object({
  quality: z.string().min(1).max(32),
  container: z.string().min(1).max(16),
  bitrateKbps: z.number().int().nonnegative().optional(),
  url: z.string().url().optional(),
  codecs: z.string().max(128).optional(),
});

const episodeSchema = z.object({
  index: z.number().int().min(1),
  title: z.string().min(1).max(512),
  url: z.string().url(),
  durationSeconds: z.number().int().nonnegative().optional(),
  thumbnailUrl: z.string().url().optional().nullable(),
  streams: z.array(streamSchema).max(32).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const authorizedSeriesResponseSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  synopsis: z.string().max(8000).optional().nullable(),
  posterUrl: z.string().url().optional().nullable(),
  canonicalUrl: z.string().min(1).max(2048).optional(),
  episodes: z.array(episodeSchema).min(1).max(5000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type AuthorizedSeriesResponse = z.infer<typeof authorizedSeriesResponseSchema>;

export const SOURCE_API_TIMEOUT_MS = 15_000;

export function allowedHosts(env: Env): string[] {
  return (env.SOURCE_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, ''))
    .filter((host) => host.length > 0);
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function apiBaseUrl(env: Env): URL | null {
  const raw = env.SOURCE_API_BASE_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw.replace(/\/+$/, ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

/** Build the outbound request for the authorized catalog API (exported for tests). */
export function buildSeriesRequest(target: URL, env: Env): { url: string; init: RequestInit } {
  const base = apiBaseUrl(env);
  if (!base) {
    throw notConfigured('SOURCE_API_BASE_URL is not configured for the authorized extractor.');
  }
  const url = new URL('v1/series', base);
  url.searchParams.set('url', target.toString());
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'vtgrab-worker/1.0 (+https://github.com/moeunzinkh-debug/VTgrabing)',
  };
  if (env.SOURCE_API_TOKEN) {
    headers.authorization = `Bearer ${env.SOURCE_API_TOKEN}`;
  }
  return { url: url.toString(), init: { method: 'GET', headers } };
}

export class AuthorizedHttpExtractor implements SourceExtractor {
  readonly key = 'authorized-http';
  readonly label = 'Authorized catalog API (HTTP)';
  readonly kind = 'authorized' as const;

  isConfigured(env: Env): boolean {
    return Boolean(apiBaseUrl(env));
  }

  canHandle(url: URL, env: Env): boolean {
    if (!this.isConfigured(env)) return false;
    const hosts = allowedHosts(env);
    const host = normalizeHost(url.hostname);
    if (hosts.length === 0) {
      // Without an explicit allow-list only the API host itself is accepted.
      const base = apiBaseUrl(env);
      return Boolean(base && normalizeHost(base.hostname) === host);
    }
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  }

  async extract(url: URL, env: Env): Promise<ExtractedSeries> {
    if (!this.isConfigured(env)) {
      throw notConfigured(
        'No authorized source is configured. Set SOURCE_API_BASE_URL (and SOURCE_API_TOKEN) to enable real catalog lookups.',
      );
    }
    if (!this.canHandle(url, env)) {
      throw notConfigured(
        `Host "${url.hostname}" is not in SOURCE_ALLOWED_HOSTS for the authorized extractor.`,
      );
    }

    const { url: requestUrl, init } = buildSeriesRequest(url, env);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SOURCE_API_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(requestUrl, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(
        `Authorized catalog API responded ${response.status} ${response.statusText || ''}`.trim(),
      );
    }

    const payload = authorizedSeriesResponseSchema.parse(await response.json());
    const episodes: ExtractedEpisode[] = payload.episodes.map((episode) => ({
      index: episode.index,
      title: episode.title,
      url: episode.url,
      durationSeconds: episode.durationSeconds ?? undefined,
      thumbnailUrl: episode.thumbnailUrl ?? undefined,
      streams: episode.streams.map((stream) => ({
        quality: stream.quality,
        container: stream.container,
        bitrateKbps: stream.bitrateKbps,
        url: stream.url,
        codecs: stream.codecs,
      })),
      metadata: episode.metadata,
    }));

    return {
      sourceKey: this.key,
      title: payload.title,
      synopsis: payload.synopsis ?? undefined,
      posterUrl: payload.posterUrl ?? undefined,
      canonicalUrl: payload.canonicalUrl ?? `${this.key}:${payload.id}`,
      sourceUrl: url.toString(),
      episodes,
      metadata: { ...(payload.metadata ?? {}), remoteId: payload.id },
    };
  }

  describe(env: Env): ProviderDescriptor {
    const configured = this.isConfigured(env);
    const hosts = allowedHosts(env);
    return {
      key: this.key,
      label: this.label,
      kind: 'authorized',
      available: configured,
      configured,
      reason: configured
        ? `Configured (${apiBaseUrl(env)!.origin}) for hosts: ${hosts.length > 0 ? hosts.join(', ') : 'api host only'}.`
        : 'Set SOURCE_API_BASE_URL + SOURCE_API_TOKEN (secret) and populate SOURCE_ALLOWED_HOSTS.',
      docs: 'README.md#authorized-source-integration',
    };
  }
}
