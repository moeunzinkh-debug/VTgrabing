import { notConfigured, unsupportedSource } from '../../core/errors';
import type { Env } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import { MockDownloadProvider } from './mock';
import { RemoteDownloadProvider } from './remote';
import type { DownloadProvider } from './types';

/** Remote (authorized) provider first: it is the production default when configured. */
const REGISTRY: DownloadProvider[] = [new RemoteDownloadProvider(), new MockDownloadProvider()];

export function listDownloadProviders(): DownloadProvider[] {
  return REGISTRY;
}

export function describeDownloadProviders(env: Env): ProviderDescriptor[] {
  return REGISTRY.map((provider) => provider.describe(env));
}

/** Default provider: the remote one when configured, otherwise the mock in dev. */
export function defaultDownloadProvider(env: Env): DownloadProvider {
  const configured = REGISTRY.filter((provider) => provider.isConfigured(env));
  const remote = configured.find((provider) => provider.kind === 'remote');
  if (remote) return remote;
  const mock = configured.find((provider) => provider.kind === 'mock');
  if (mock) return mock;
  throw notConfigured(
    'No download provider is configured. Set DOWNLOAD_SERVICE_URL + DOWNLOAD_SERVICE_TOKEN for production, or MOCK_ENABLED=true for local development.',
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
