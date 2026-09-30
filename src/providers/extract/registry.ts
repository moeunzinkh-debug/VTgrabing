import { unsupportedSource } from '../../core/errors';
import type { Env } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import { AuthorizedHttpExtractor } from './authorized';
import { HttpSniffExtractor } from './http-sniff';
import { MockExtractor } from './mock';
import type { SourceExtractor } from './types';

/**
 * Resolution order for `POST /api/analyze`:
 *   1. `authorized-http` - an operator configured catalog API (explicit opt-in)
 *   2. `http-sniff`      - the real link grabber: open the URL, find the videos
 *   3. `mock`            - synthetic data, development/tests only
 */
const REGISTRY: SourceExtractor[] = [
  new AuthorizedHttpExtractor(),
  new HttpSniffExtractor(),
  new MockExtractor(),
];

export function listExtractors(): SourceExtractor[] {
  return REGISTRY;
}

export function describeExtractors(env: Env): ProviderDescriptor[] {
  return REGISTRY.map((extractor) => extractor.describe(env));
}

/** Pick the extractor for a URL: explicit `sourceKey` wins, else first match. */
export function resolveExtractor(url: URL, env: Env, sourceKey?: string): SourceExtractor {
  if (sourceKey) {
    const requested = REGISTRY.find((extractor) => extractor.key === sourceKey);
    if (!requested) {
      throw unsupportedSource(`Unknown source "${sourceKey}"`, {
        known: REGISTRY.map((extractor) => extractor.key),
      });
    }
    if (!requested.isConfigured(env)) {
      throw unsupportedSource(`Source "${sourceKey}" is not configured on this deployment.`, {
        reason: requested.describe(env).reason,
      });
    }
    if (!requested.canHandle(url, env)) {
      throw unsupportedSource(`Source "${sourceKey}" cannot handle ${url.hostname}.`, {
        allowedHosts: env.SOURCE_ALLOWED_HOSTS,
      });
    }
    return requested;
  }

  const match = REGISTRY.find((extractor) => extractor.isConfigured(env) && extractor.canHandle(url, env));
  if (!match) {
    throw unsupportedSource(`No extractor is able to handle ${url.toString()} on this deployment.`, {
      extractors: describeExtractors(env),
    });
  }
  return match;
}
