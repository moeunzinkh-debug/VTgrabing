import { notConfigured, unsupportedSource } from '../../core/errors';
import type { Env } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import { HttpStreamDownloadProvider } from './http-stream';
import { MockDownloadProvider } from './mock';
import { RemoteDownloadProvider } from './remote';
import type { DownloadProvider } from './types';

/**
 * Default provider order:
 *   1. `remote`      - only when the operator configured their own download service
 *   2. `http-stream` - the real grabber: the Worker downloads the bytes itself
 *   3. `mock`        - synthetic bytes, development/tests only
 */
const REGISTRY: DownloadProvider[] = [
  new RemoteDownloadProvider(),
  new HttpStreamDownloadProvider(),
  new MockDownloadProvider(),
];

export function listDownloadProviders(): DownloadProvider[] {
  return REGISTRY;
}

export function describeDownloadProviders(env: Env): ProviderDescriptor[] {
  return REGISTRY.map((provider) => provider.describe(env));
}

/** Default provider: configured remote, else the real HTTP grabber, else the mock. */
export function defaultDownloadProvider(env: Env): DownloadProvider {
  const configured = REGISTRY.filter((provider) => provider.isConfigured(env));
  const remote = configured.find((provider) => provider.kind === 'remote');
  if (remote) return remote;
  const grabber = configured.find((provider) => provider.kind === 'http');
  if (grabber) return grabber;
  const mock = configured.find((provider) => provider.kind === 'mock');
  if (mock) return mock;
  throw notConfigured(
    'No download provider is configured. Keep GRAB_ENABLED=true to download with the built-in grabber, set DOWNLOAD_SERVICE_URL + DOWNLOAD_SERVICE_TOKEN for an external service, or MOCK_ENABLED=true for local development.',
  );
}

export function resolveDownloadProvider(env: Env, key?: string): DownloadProvider {
  if (!key) return defaultDownloadProvider(env);
  const provider = REGISTRY.find((candidate) => candidate.key === key);
  if (!provider) {
    throw unsupportedSource(`Unknown download provider "${key}"`, {
      known: REGISTRY.map((candidate) => candidate.key),
    });
  }
  if (!provider.isConfigured(env)) {
    throw notConfigured(`Download provider "${key}" is not configured on this deployment.`, {
      reason: provider.describe(env).reason,
    });
  }
  return provider;
}
