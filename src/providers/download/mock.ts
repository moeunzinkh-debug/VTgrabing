import { fnv1a, hexFromHash } from '../../core/ids';
import { notConfigured } from '../../core/errors';
import type { Env } from '../../env';
import { mocksEnabled } from '../../env';
import { notFound } from '../../core/errors';
import type { ProviderDescriptor } from '../../shared/types';
import type { DownloadProvider, DownloadRequest, DownloadResult } from './types';

/** Deterministic PRNG so a given episode always produces identical bytes. */
function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Local development / test provider.
 *
 * It produces **synthetic bytes only** - it is not a video downloader and it never
 * contacts a video host. The generated object starts with a plain text banner that
 * says exactly that. Disabled unless `MOCK_ENABLED=true`.
 */
export class MockDownloadProvider implements DownloadProvider {
  readonly key = 'mock';
  readonly label = 'Mock downloader (local development only, synthetic bytes)';
  readonly kind = 'mock' as const;

  isConfigured(env: Env): boolean {
    return mocksEnabled(env);
  }

  async start(request: DownloadRequest, env: Env): Promise<DownloadResult> {
    if (!this.isConfigured(env)) {
      throw notConfigured(
        'MockDownloadProvider is disabled. Set MOCK_ENABLED=true for local development only.',
      );
    }

    const seed = fnv1a(`${request.jobId}:${request.episodeIndex}:${request.quality}`);
    const banner = [
      'VTGrab MOCK OBJECT - NOT REAL MEDIA',
      `series: ${request.seriesTitle}`,
      `episode: ${request.episodeIndex} - ${request.episodeTitle}`,
      `quality: ${request.quality}`,
      `container: ${request.container}`,
      `source: ${request.sourceUrl}`,
      `seed: ${hexFromHash(seed)}`,
      'This payload was generated locally by MockDownloadProvider for development and tests.',
      '',
    ].join('\n');

    const header = new TextEncoder().encode(banner);
    // 64 KiB - 192 KiB: small enough for fast tests, large enough to be a real stream.
    const bodyLength = 65_536 + (seed % 8) * 16_384;
    const bytes = new Uint8Array(header.length + bodyLength);
    bytes.set(header, 0);

    const random = xorshift(seed);
    for (let offset = 0; offset < bodyLength; offset += 4) {
      const value = random();
      const base = header.length + offset;
      const remaining = Math.min(4, bodyLength - offset);
      for (let byteIndex = 0; byteIndex < remaining; byteIndex += 1) {
        bytes[base + byteIndex] = (value >>> (byteIndex * 8)) & 0xff;
      }
    }

    const checksum = await sha256Hex(bytes);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Chunked on purpose: exercises the streaming R2 writer, not a single put().
        const chunkSize = 32 * 1024;
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          controller.enqueue(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
        }
        controller.close();
      },
    });

    return {
      kind: 'stream',
      stream,
      contentLength: bytes.byteLength,
      contentType: 'application/octet-stream',
      checksumSha256: checksum,
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
        ? 'Writes synthetic objects to R2. No real media is downloaded.'
        : 'Disabled because MOCK_ENABLED=false.',
      docs: 'README.md#local-development',
    };
  }
}

/** Thrown by helper lookups when a provider key does not exist. */
export function unknownProvider(key: string): never {
  throw notFound(`Unknown download provider "${key}"`);
}
