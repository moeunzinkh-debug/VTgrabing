import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { resolveDownloadProvider } from '../src/providers/download/registry';
import type { DownloadRequest } from '../src/providers/download/types';
import { TikTokSsstikDownloadProvider, resetSsstikPacing } from '../src/providers/download/tiktok-ssstik';
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
  vi.useRealTimers();
  resetSsstikPacing();
});

/**
 * Standard-alphabet base64, the spelling SSSTik embeds in its CDN paths.
 * `btoa` (not Buffer) because the suite runs inside workerd.
 */
const b64 = (value: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)));

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

describe('TikTokSsstikDownloadProvider - wrapped links, signals and pacing', () => {
  /** Signed CDN target whose base64 is short enough to stay one path segment. */
  const REAL_MP4 = 'https://v16-web.tiktokcdn-us.com/tos/useast5/abc123/video.mp4?nonce=26013';

  /**
   * Signed CDN target whose base64 contains `/`, so the wrapper path splits into
   * several segments ([2, 6, 163, 40] for ssscdn.io/en/ssstik/<payload>).
   *
   * `/` is part of the base64 alphabet, which is why unwrapping has to *rejoin*
   * the trailing segments rather than decode the last one: a single-segment scan
   * finds nothing for exactly the long signed URLs that matter most.
   */
  const REAL_MP4_MULTI =
    'https://p16-amd-va.tiktokcdn.com/tos-maliva-v-0068/' +
    'o0Ek9ZBpLIAz1x2vQcFwPbSdHqYtRr4hM4yLz7Cv1aEe6~tplv-tiktokx-origin.image?dr=14579&x-expires=1790000000';

  /**
   * Every media URL this stub will serve. It has to include the plain
   * `video.mp4` that the shared `RESULTS` fragment references, not just the two
   * wrapped-link fixtures, or a test that passes `RESULTS` (the pacing tests)
   * reaches the media hop and gets a 404 from the fallback below.
   */
  const SERVED_MEDIA = ['https://v16.tiktokcdn.com/video.mp4', REAL_MP4, REAL_MP4_MULTI];

  function stubSsstik(fragment: string, fragmentHeaders: Record<string, string> = {}) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://ssstik.io/') {
        return response(PAGE, { 'content-type': 'text/html; charset=utf-8' });
      }
      if (url === 'https://ssstik.io/abc?url=dl') {
        return response(fragment, { 'content-type': 'text/html', ...fragmentHeaders });
      }
      if (SERVED_MEDIA.includes(url)) {
        return response(MP4, { 'content-type': 'video/mp4', 'content-length': String(MP4.byteLength) });
      }
      return new Response('unexpected ' + url, { status: 404 });
    });
    return calls;
  }

  it('decodes a base64-wrapped ssscdn.io link instead of fetching the wrapper', async () => {
    const wrapped = '<a class="pure-button dl-button download_link without_watermark" ' +
      `href="https://ssscdn.io/en/ssstik/${b64(REAL_MP4)}">Download</a>`;
    const calls = stubSsstik(wrapped);

    const result = await new TikTokSsstikDownloadProvider().start(request(), enabledEnv());
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') throw new Error('expected a stream result');
    expect(new Uint8Array(await new Response(result.stream).arrayBuffer())).toEqual(MP4);

    // The wrapper is never requested; the decoded, allow-listed CDN URL is.
    expect(calls).not.toContain(`https://ssscdn.io/en/ssstik/${b64(REAL_MP4)}`);
    expect(calls).toContain(REAL_MP4);
  });

  it('decodes the tikcdn.io product/kind/base64 shape too', async () => {
    const wrapped = `<a class="download_link without_watermark" href="https://tikcdn.io/ssstik/a/${b64(REAL_MP4)}">Download</a>`;
    const calls = stubSsstik(wrapped);
    await new TikTokSsstikDownloadProvider().start(request(), enabledEnv());
    expect(calls).toContain(REAL_MP4);
  });

  it('rejoins a base64 payload that the wrapper path split into several segments', async () => {
    const wrapped =
      '<a class="pure-button dl-button download_link without_watermark" ' +
      `href="https://ssscdn.io/en/ssstik/${b64(REAL_MP4_MULTI)}">Download</a>`;
    // Sanity: this payload really does span several path segments, otherwise the
    // test would pass for the wrong reason.
    expect(new URL(`https://ssscdn.io/en/ssstik/${b64(REAL_MP4_MULTI)}`).pathname.split('/').filter(Boolean).length)
      .toBeGreaterThan(3);

    const calls = stubSsstik(wrapped);
    const result = await new TikTokSsstikDownloadProvider().start(request(), enabledEnv());
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') throw new Error('expected a stream result');
    expect(new Uint8Array(await new Response(result.stream).arrayBuffer())).toEqual(MP4);
    expect(calls).toContain(REAL_MP4_MULTI);
  });

  it('refuses a decoded payload that points outside the media allow-list', async () => {
    const wrapped = `<a class="download_link without_watermark" href="https://ssscdn.io/en/ssstik/${b64('https://evil.example/steal.mp4')}">Download</a>`;
    const calls = stubSsstik(wrapped);
    // Links are unwrapped but *not* allow-listed at parse time, so the refusal
    // happens at fetch time and names the host that was decoded - and the decoded
    // host is never actually contacted.
    await expect(new TikTokSsstikDownloadProvider().start(request(), enabledEnv())).rejects.toThrow(
      /outside VTGrab's safety allow-list: evil\.example/,
    );
    expect(calls.some((url) => url.includes('evil.example'))).toBe(false);
  });

  it('retries once with a fresh shell token when SSSTik rate-limits the post', async () => {
    let posts = 0;
    const bodies: string[] = [];
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://ssstik.io/') return response(PAGE, { 'content-type': 'text/html' });
      if (url === 'https://ssstik.io/abc?url=dl') {
        posts += 1;
        bodies.push(String(init.body));
        if (posts === 1) return response('', { 'content-type': 'text/html', 'hx-trigger': 'ssslimitexceed' });
        return response(RESULTS, { 'content-type': 'text/html', 'hx-trigger': 'ssssuccess_video' });
      }
      if (url === 'https://v16.tiktokcdn.com/video.mp4') {
        return response(MP4, { 'content-type': 'video/mp4', 'content-length': String(MP4.byteLength) });
      }
      return new Response(null, { status: 404 });
    });

    const env = enabledEnv({ TIKTOK_SSTIK_COOLDOWN_SECONDS: '0' });
    const result = await new TikTokSsstikDownloadProvider().start(request(), env);
    expect(result.kind).toBe('stream');
    expect(posts).toBe(2);
    // Exactly one retry: shell + form + shell + form + media, and no more.
    expect(calls).toEqual([
      'https://ssstik.io/',
      'https://ssstik.io/abc?url=dl',
      'https://ssstik.io/',
      'https://ssstik.io/abc?url=dl',
      'https://v16.tiktokcdn.com/video.mp4',
    ]);
    // The retry re-read the shell, so both POSTs carry the page token.
    expect(bodies[0]).toContain('tt=public-form-token-123');
    expect(bodies[1]).toContain('tt=public-form-token-123');
  });

  it('gives up after one retry when the rate limit persists', async () => {
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://ssstik.io/') return response(PAGE, { 'content-type': 'text/html' });
      if (url === 'https://ssstik.io/abc?url=dl') {
        posts += 1;
        return response('', { 'content-type': 'text/html', 'hx-trigger': 'ssslimitexceed' });
      }
      return new Response(null, { status: 404 });
    });

    const env = enabledEnv({ TIKTOK_SSTIK_COOLDOWN_SECONDS: '0' });
    await expect(new TikTokSsstikDownloadProvider().start(request(), env)).rejects.toThrow(/rate-limited/);
    expect(posts).toBe(2);
  });

  it('reports the watermark-only verdict instead of a generic "no link" error', async () => {
    stubSsstik('<p class="maintext">caption</p>', { 'hx-trigger': 'ssssuccess_wmonly' });
    await expect(new TikTokSsstikDownloadProvider().start(request(), enabledEnv())).rejects.toThrow(
      /only find the watermarked version/,
    );
  });

  it('reports a photo carousel as a carousel, not as a broken response', async () => {
    stubSsstik('<a class="download_link music" href="https://sf16-ies-music-va.tiktokcdn.com/a.mp3">MP3</a>', {
      'hx-trigger': 'ssssuccess_slides',
    });
    await expect(new TikTokSsstikDownloadProvider().start(request(), enabledEnv())).rejects.toThrow(
      /photo\/slide carousel/,
    );
  });

  it('says "audio only" when SSSTik returns an MP3 but no MP4 and sends no verdict', async () => {
    stubSsstik('<a class="download_link music" href="https://sf16-ies-music-va.tiktokcdn.com/a.mp3">MP3</a>');
    await expect(new TikTokSsstikDownloadProvider().start(request(), enabledEnv())).rejects.toThrow(
      /only an audio \(MP3\) link/,
    );
  });

  it('does not blame a missing MP4 on the HD tier', async () => {
    stubSsstik('', { 'hx-trigger': 'sssrapidapifakehd' });
    await expect(new TikTokSsstikDownloadProvider().start(request(), enabledEnv())).rejects.toThrow(
      /no MP4 link for this post/,
    );
  });

  it('accepts a photo post and a TikTok short link, and normalises both', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url === 'https://ssstik.io/') return response(PAGE, { 'content-type': 'text/html' });
      if (url === 'https://ssstik.io/abc?url=dl') {
        bodies.push(String(init.body));
        return response(RESULTS, { 'content-type': 'text/html' });
      }
      if (url === 'https://v16.tiktokcdn.com/video.mp4') {
        return response(MP4, { 'content-type': 'video/mp4', 'content-length': String(MP4.byteLength) });
      }
      return new Response(null, { status: 404 });
    });

    // A carousel post is normalised to the /video/ spelling SSSTik expects.
    await new TikTokSsstikDownloadProvider().start(
      request('https://www.tiktok.com/@creator/photo/7435208327249939713'),
      enabledEnv(),
    );
    expect(decodeURIComponent(bodies[0])).toContain('https://www.tiktok.com/@creator/video/7435208327249939713');

    // A short link has no id we can normalise to, so it is forwarded verbatim.
    await new TikTokSsstikDownloadProvider().start(request('https://vm.tiktok.com/ZM8abcdEF/'), enabledEnv());
    expect(decodeURIComponent(bodies[1])).toContain('https://vm.tiktok.com/ZM8abcdEF/');
  });

  it('still rejects a profile link, because SSSTik downloads one post at a time', async () => {
    await expect(
      new TikTokSsstikDownloadProvider().start(request('https://www.tiktok.com/@creator'), enabledEnv()),
    ).rejects.toThrow(/is a profile link/);
  });

  it('spaces its own requests when the pacer is enabled', async () => {
    stubSsstik(RESULTS);
    const env = enabledEnv({ TIKTOK_SSTIK_MIN_INTERVAL_MS: '120' });
    const startedAt = Date.now();
    const result = await new TikTokSsstikDownloadProvider().start(request(), env);
    expect(result.kind).toBe('stream');
    // The two SSSTik requests (shell GET, then form POST) are one paced gap
    // apart: the first request never waits (nothing preceded it), the second
    // waits out the ~120 ms interval. The media fetch is not paced -- it goes to
    // TikTok's CDN, which does not rate-limit us the way SSSTik's form does --
    // so this asserts one gap, not two.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
  });

  it('does not pace at all when the interval is zero', async () => {
    stubSsstik(RESULTS);
    const env = enabledEnv({ TIKTOK_SSTIK_MIN_INTERVAL_MS: '0' });
    const startedAt = Date.now();
    await new TikTokSsstikDownloadProvider().start(request(), env);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});
