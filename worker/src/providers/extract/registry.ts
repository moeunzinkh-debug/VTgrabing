import { unsupportedSource } from '../../core/errors';
import type { Env } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import { AuthorizedHttpExtractor } from './authorized';
import { MockExtractor } from './mock';
import type { SourceExtractor } from './types';

const REGISTRY: SourceExtractor[] = [new AuthorizedHttpExtractor(), new MockExtractor()];

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
