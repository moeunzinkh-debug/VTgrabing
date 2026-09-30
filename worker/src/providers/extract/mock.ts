import { fnv1a, hexFromHash } from '../../core/ids';
import { notConfigured } from '../../core/errors';
import type { Env } from '../../env';
import { mocksEnabled } from '../../env';
import type { ProviderDescriptor } from '../../shared/types';
import type { ExtractedEpisode, ExtractedSeries, SourceExtractor } from './types';

const ADJECTIVES = [
  'Silent',
  'Crimson',
  'Northern',
  'Electric',
  'Hidden',
  'Golden',
  'Broken',
  'Endless',
  'Quiet',
  'Distant',
];
const NOUNS = [
  'Harbor',
  'Orbit',
  'Season',
  'Signal',
  'River',
  'Machine',
  'Garden',
  'Archive',
  'Lantern',
  'Circuit',
];

const QUALITIES: Array<{ quality: string; bitrateKbps: number }> = [
  { quality: '1080p', bitrateKbps: 5200 },
  { quality: '720p', bitrateKbps: 2800 },
  { quality: '480p', bitrateKbps: 1200 },
];

/**
 * Deterministic fake catalog used for `wrangler dev` and the automated tests.
 *
 * It never touches the network and the payloads it describes are NOT real media:
 * the matching `MockDownloadProvider` writes a clearly labelled synthetic object.
 * `MOCK_ENABLED=false` (the production default) disables it completely.
 */
export class MockExtractor implements SourceExtractor {
  readonly key = 'mock';
  readonly label = 'Mock catalog (local development only)';
  readonly kind = 'mock' as const;

  isConfigured(env: Env): boolean {
    return mocksEnabled(env);
  }

  canHandle(_url: URL, env: Env): boolean {
    return mocksEnabled(env);
  }

  async extract(url: URL, env: Env): Promise<ExtractedSeries> {
    if (!this.isConfigured(env)) {
      throw notConfigured(
        'MockExtractor is disabled. Set MOCK_ENABLED=true for local development only.',
      );
    }

    const hash = fnv1a(url.toString());
    const hex = hexFromHash(hash);
    const adjective = ADJECTIVES[hash % ADJECTIVES.length];
    const noun = NOUNS[(hash >>> 5) % NOUNS.length];
    const episodeCount = 6 + (hash % 7);

    const episodes: ExtractedEpisode[] = Array.from({ length: episodeCount }, (_unused, offset) => {
      const index = offset + 1;
      const episodeHash = fnv1a(`${hex}:${index}`);
      return {
        index,
        title: `Episode ${index} - ${ADJECTIVES[episodeHash % ADJECTIVES.length]} ${
          NOUNS[(episodeHash >>> 7) % NOUNS.length]
        }`,
        url: `${url.origin}/mock/${hex}/episode/${index}`,
        durationSeconds: 1320 + ((episodeHash % 9) * 45),
        thumbnailUrl: undefined,
        streams: QUALITIES.map((entry) => ({
          quality: entry.quality,
          container: 'mp4',
          bitrateKbps: entry.bitrateKbps,
          url: `${url.origin}/mock/${hex}/episode/${index}/${entry.quality}.mp4`,
          codecs: 'avc1.640028,mp4a.40.2',
        })),
        metadata: { mock: true, seed: hex },
      };
    });

    return {
      sourceKey: this.key,
      title: `${adjective} ${noun} (mock #${hex})`,
      synopsis:
        'Synthetic series produced by MockExtractor for local development and tests. It contains no real media.',
      posterUrl: undefined,
      canonicalUrl: `mock:${hex}`,
      sourceUrl: url.toString(),
      episodes,
      metadata: { mock: true, seed: hex, generatedBy: 'MockExtractor' },
    };
  }

  describe(env: Env): ProviderDescriptor {
    const available = this.isConfigured(env);
    return {
      key: this.key,
      label: this.label,
      kind: 'mock',
      available,
      configured: available,
      reason: available
        ? 'Synthetic catalog, safe for local development and tests.'
        : 'Disabled because MOCK_ENABLED=false.',
      docs: 'README.md#local-development',
    };
  }
}
