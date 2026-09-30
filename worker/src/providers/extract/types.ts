import type { Env } from '../../env';
import type { ProviderDescriptor, StreamInfo } from '../../shared/types';

export interface ExtractedEpisode {
  /** 1-based episode number inside the series. */
  index: number;
  title: string;
  /** Canonical web page / manifest URL of the episode. */
  url: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  streams: StreamInfo[];
  metadata?: Record<string, unknown>;
}

export interface ExtractedSeries {
  sourceKey: string;
  title: string;
  synopsis?: string;
  posterUrl?: string;
  /** Normalized URL used as the deduplication key in D1. */
  canonicalUrl: string;
  /** URL exactly as the user submitted it. */
  sourceUrl: string;
  episodes: ExtractedEpisode[];
  metadata?: Record<string, unknown>;
}

/**
 * Contract every metadata source must implement.
 *
 * `MockExtractor` is a local development / test implementation.
 * `AuthorizedHttpExtractor` is the production integration point: it talks to an
 * authorized catalog API the operator owns (or is licensed to call).
 */
export interface SourceExtractor {
  readonly key: string;
  readonly label: string;
  readonly kind: 'mock' | 'authorized';
  /** Are the required secrets/vars present to use this extractor? */
  isConfigured(env: Env): boolean;
  /** Is this extractor allowed/able to handle the given URL? */
  canHandle(url: URL, env: Env): boolean;
  extract(url: URL, env: Env, signal?: AbortSignal): Promise<ExtractedSeries>;
  describe(env: Env): ProviderDescriptor;
}
