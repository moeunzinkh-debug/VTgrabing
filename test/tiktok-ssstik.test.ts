import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { resolveDownloadProvider } from '../src/providers/download/registry';
import type { DownloadRequest } from '../src/providers/download/types';
import { TikTokSsstikDownloadProvider } from '../src/providers/download/tiktok-ssstik';
import { JobService } from '../src/jobs/service';
import { analyze, repository, testEnv } from './helpers';

const POST_URL = 'https://www.tiktok.com/@creator/video/1234567890123456789?share_item_id=123';
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const PAGE = `<html><script>const s_tt = 'public-form-token-123';</script></html>`;
const RESULTS = '<a class="button without_watermark" href="https://v16.tiktokcdn.com/video.mp4">Download</a>';

function enabledEnv(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, TIKTOK_SSTIK_ENABLED: 'true', ...overrides } as Env;
}

function request(sourceUrl = POST_URL): DownloadRequest {
  return {
    jobItemId: 'item_1',
    jobId: 'job_1',
    seriesId: 'series_1',
    seriesTitle: 'TikTok clip',
    episodeId: 'episode_1',
    episodeIndex: 1,
    episodeTitle: 'Clip one',
    sourceUrl,
    quality: 'source',
    container: 'mp4',
    objectKey: 'vtgrab/tiktok/clip.mp4',
    filename: 'clip.mp4',
    callbackOrigin: 'https://vtgrab.example.com',
  };
}

function response(body: BodyInit | null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TikTokSsstikDownloadProvider', () => {
  it('is explicitly disabled by default and never becomes the default provider', () => {
    const provider = new TikTokSsstikDownloadProvider();
    expect(provider.isConfigured(testEnv)).toBe(false);
    expect(provider.describe(testEnv).reason).toContain('TIKTOK_SSTIK_ENABLED=true');
    expect(resolveDownloadProvider(testEnv).key).toBe('mock');
    const optIn = enabledEnv({ GRAB_ENABLED: 'false' });
    expect(resolveDownloadProvider(optIn).key).toBe('mock');
    expect(resolveDownloadProvider(optIn, 'tiktok-ssstik').key).toBe('tiktok-ssstik');
  });

  it('requires explicit third-party/rightsholder consent and only accepts TikTok series jobs', async () => {
    const found = await analyze(`https://mock.local/series/ssstik-consent-${Date.now()}`);
    const service = new JobService(enabledEnv(), repository());
    const input = {
      seriesId: found.series.id,
      selection: { mode: 'ids' as const, episodeIds: [found.episodes[0].id] },
      options: { provider: 'tiktok-ssstik' },
    };
    await expect(service.createJob(input)).rejects.toThrow(/Confirm that you own or have permission/);
    await expect(
      service.createJob({ ...input, options: { provider: 'tiktok-ssstik', thirdPartyConsent: true } }),
    ).rejects.toThrow(/only supports TikTok post listings/);
  });

  it('validates the TikTok URL before making requests', async () => {
    const fetchMock = vi.fn(async () => response(PAGE, { 'content-type': 'text/html' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new TikTokSsstikDownloadProvider().start(request('https://example.com/video.mp4'), enabledEnv())).rejects.toThrow(
      /public HTTPS TikTok video post URL/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one validated post URL to SSSTik and streams only a signature-checked MP4', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://ssstik.io/') {
        return response(PAGE, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'session=ephemeral; Path=/; Secure',
        });
      }
      if (url === 'https://ssstik.io/abc?url=dl') {
        return response(RESULTS, { 'content-type': 'text/html' });
      }
      if (url === 'https://v16.tiktokcdn.com/video.mp4') {
        return response(MP4, { 'content-type': 'video/mp4', 'content-length': String(MP4.byteLength) });
      }
      return new Response('unexpected', { status: 404 });
    });

    const result = await new TikTokSsstikDownloadProvider().start(request(), enabledEnv());
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') throw new Error('expected a stream result');
    expect(result.contentType).toBe('video/mp4');
    expect(result.container).toBe('mp4');
    expect(result.contentLength).toBe(MP4.byteLength);
    expect(new Uint8Array(await new Response(result.stream).arrayBuffer())).toEqual(MP4);

    expect(calls.map((call) => call.url)).toEqual([
      'https://ssstik.io/',
      'https://ssstik.io/abc?url=dl',
      'https://v16.tiktokcdn.com/video.mp4',
    ]);
    const formCall = calls[1];
    expect(formCall.init.method).toBe('POST');
    expect(String(formCall.init.body)).toContain('https%3A%2F%2Fwww.tiktok.com%2F%40creator%2Fvideo%2F1234567890123456789');
    expect(new Headers(formCall.init.headers).get('cookie')).toBe('session=ephemeral');
  });

  it('refuses a media redirect to an unapproved host before fetching it', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url === 'https://ssstik.io/') return response(PAGE, { 'content-type': 'text/html' });
      if (url === 'https://ssstik.io/abc?url=dl') return response(RESULTS, { 'content-type': 'text/html' });
      if (url === 'https://v16.tiktokcdn.com/video.mp4') {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal.mp4' } });
      }
      return new Response(null, { status: 404 });
    });

    await expect(new TikTokSsstikDownloadProvider().start(request(), enabledEnv())).rejects.toThrow(
      /outside VTGrab's safety allow-list/,
    );
    expect(urls).not.toContain('https://evil.example/steal.mp4');
  });

  it('rejects non-MP4 media before returning a stream', async () => {
    const notMp4 = new Uint8Array([0, 0, 0, 8, 0, 0, 0, 0]);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://ssstik.io/') return response(PAGE, { 'content-type': 'text/html' });
      if (url === 'https://ssstik.io/abc?url=dl') return response(RESULTS, { 'content-type': 'text/html' });
      if (url === 'https://v16.tiktokcdn.com/video.mp4') {
        return response(notMp4, { 'content-type': 'application/octet-stream', 'content-length': String(notMp4.byteLength) });
      }
      return new Response(null, { status: 404 });
    });

    await expect(new TikTokSsstikDownloadProvider().start(request(), enabledEnv())).rejects.toThrow(/invalid ftyp signature/);
  });
});
