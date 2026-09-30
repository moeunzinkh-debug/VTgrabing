import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { HttpStreamDownloadProvider } from '../src/providers/download/http-stream';
import type { DownloadRequest, DownloadResult } from '../src/providers/download/types';
import { grabConfig } from '../src/grab/config';
import { Budget } from '../src/grab/net';
import { baseHeaders } from '../src/grab/config';
import { chunkedDownload, inspectResource } from '../src/grab/fetch-stream';
import type { StreamOptions } from '../src/grab/fetch-stream';
import { testEnv } from './helpers';

/**
 * Byte-level tests for the real downloader.
 *
 * `globalThis.fetch` is replaced with a tiny origin that speaks the parts of HTTP that
 * matter (Content-Length, Accept-Ranges, 206 + Content-Range, HEAD, transient 5xx), so
 * these tests assert the bytes VTGrab would store, not a mocked return value.
 */

type Entry = {
  body: Uint8Array | string;
  type: string;
  status?: number;
  ranges?: boolean;
  /** Fail this many times before answering. */
  flaky?: number;
  /** Lie about the length: serve only this fraction of the advertised bytes. */
  truncateTo?: number;
};

function payload(size: number, seed = 1): Uint8Array {
  const buffer = new Uint8Array(size);
  const view = new DataView(buffer.buffer);
  let state = (seed >>> 0) || 0x9e3779b9;
  for (let offset = 0; offset + 4 <= size; offset += 4) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    view.setUint32(offset, state, false);
  }
  return buffer;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function stubSite(entries: Record<string, Entry>) {
  const seen: { url: string; method: string; range: string | null; referer: string | null }[] = [];
  const failures = new Map<string, number>();

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    const headers = new Headers((init?.headers ?? undefined) as HeadersInit | undefined);
    const method = (init?.method ?? 'GET').toUpperCase();
    seen.push({ url: raw, method, range: headers.get('range'), referer: headers.get('referer') });

    const entry = entries[url.pathname];
    if (!entry) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    const probing = headers.get('range') === 'bytes=0-0';
    if (entry.flaky && !probing) {
      const left = failures.get(url.pathname) ?? entry.flaky;
      if (left > 0) {
        failures.set(url.pathname, left - 1);
        return new Response('gateway boom', { status: 502, headers: { 'content-type': 'text/plain' } });
      }
    }
    const full = typeof entry.body === 'string' ? new TextEncoder().encode(entry.body) : entry.body;
    const body = entry.truncateTo === undefined ? full : full.subarray(0, entry.truncateTo);

    const respond = (slice: Uint8Array, extra: Record<string, string>, code: number) =>
      new Response(method === 'HEAD' ? null : slice.slice(), {
        status: code,
        headers: {
          'content-type': entry.type,
          // A HEAD always advertises the real length, even when the GET is truncated:
          // that is exactly the "host lies about the body" case the guard must catch.
          'content-length': String(method === 'HEAD' ? full.byteLength : slice.byteLength),
          ...(entry.ranges === false ? {} : { 'accept-ranges': 'bytes' }),
          ...extra,
        },
      });

    const status = entry.status ?? 200;
    const match = /bytes=(\d+)-(\d+)/.exec(headers.get('range') ?? '');
    if (match && entry.ranges !== false) {
      const start = Number.parseInt(match[1], 10);
      const end = Math.min(body.byteLength - 1, Number.parseInt(match[2], 10));
      if (start > end || start >= body.byteLength) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${full.byteLength}` } });
      }
      return respond(body.subarray(start, end + 1), { 'content-range': `bytes ${start}-${end}/${full.byteLength}` }, status === 200 ? 206 : status);
    }
    return respond(body, {}, status);
  };

  vi.stubGlobal('fetch', vi.fn(handler as unknown as typeof fetch));
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = (overrides: Record<string, string> = {}): Env =>
  ({
    ...testEnv,
    GRAB_ENABLED: 'true',
    GRAB_MAX_VIDEO_BYTES: String(32 * 1024 * 1024),
    ...overrides,
  }) as Env;

const provider = new HttpStreamDownloadProvider();

/**
 * `sourceUrl` is the page the link came from (what a re-discovery would re-open);
 * `streamUrl` is the media the downloader should fetch.
 */
function request(pageUrl: string, streamUrl: string, quality = 'source'): DownloadRequest {
  return { sourceUrl: pageUrl, streamUrl, quality, container: 'mp4' } as DownloadRequest;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return concat(parts);
}

type Grab = { result: Extract<DownloadResult, { kind: 'stream' }>; bytes: Uint8Array };

/** Runs the provider and drains what it produced, i.e. the bytes that would be stored. */
async function grab(pageUrl: string, streamUrl: string, options: { env?: Env; quality?: string } = {}): Promise<Grab> {
  const result = await provider.start(request(pageUrl, streamUrl, options.quality ?? 'source'), options.env ?? env());
  if (result.kind !== 'stream') throw new Error('expected the grabber to stream bytes, got a deferred result');
  return { result, bytes: await collect(result.stream) };
}

describe('progressive downloads transfer the real bytes', () => {
  it('assembles ranged chunks and verifies the advertised length', async () => {
    const source = payload(3 * 1024 * 1024 + 5, 7);
    const seen = stubSite({ '/movie.mp4': { body: source, type: 'video/mp4' } });

    const { result, bytes } = await grab('https://site.source.dev/watch/1', 'https://media.source.dev/movie.mp4');

    expect(bytes).toEqual(source);
    expect(result.container).toBe('mp4');
    expect(result.contentLength).toBe(source.byteLength);
    // A one byte range probe is how the length is learned, then the part is fetched.
    expect(seen.map((entry) => entry.range)).toEqual(['bytes=0-0', 'bytes=0-3145732']);
  });

  it('infers a playable MIME type when a video host answers application/octet-stream', async () => {
    const source = payload(32 * 1024, 8);
    stubSite({ '/generic.mp4': { body: source, type: 'application/octet-stream' } });

    const { result, bytes } = await grab('https://site.source.dev/watch/15', 'https://media.source.dev/generic.mp4');

    expect(bytes).toEqual(source);
    expect(result.contentType).toBe('video/mp4');
  });

  it('requests one part per chunk and stops at the file size', async () => {
    const source = payload(200 * 1024, 12);
    const seen = stubSite({ '/parts.mp4': { body: source, type: 'video/mp4' } });
    const cfg = { ...grabConfig(env()), chunkBytes: 64 * 1024 };
    const options: StreamOptions = {
      cfg,
      headers: baseHeaders(cfg, 'https://site.source.dev/watch/2'),
      budget: new Budget(cfg.maxSubrequests),
      maxBytes: source.byteLength,
    };
    const info = await inspectResource('https://media.source.dev/parts.mp4', options);
    expect({ total: info.totalBytes, ranges: info.acceptsRanges }).toEqual({ total: source.byteLength, ranges: true });

    const parts: Uint8Array[] = [];
    for await (const chunk of chunkedDownload('https://media.source.dev/parts.mp4', info, options)) parts.push(chunk);

    expect(parts).toHaveLength(4);
    expect(concat(parts)).toEqual(source);
    expect(seen.map((entry) => entry.range)).toEqual([
      'bytes=0-0',
      'bytes=0-65535',
      'bytes=65536-131071',
      'bytes=131072-196607',
      'bytes=196608-204799',
    ]);
  });

  it('fails a transfer the origin cannot complete', async () => {
    // Advertises 200 KiB, keeps only 150 KiB: the missing tail has to surface as an
    // error, never as a silently short file in storage.
    stubSite({
      '/short.mp4': { body: payload(200 * 1024, 13), type: 'video/mp4', truncateTo: 150 * 1024 },
    });
    await expect(grab('https://site.source.dev/watch/14', 'https://media.source.dev/short.mp4')).rejects.toThrow(
      /Incomplete download|HTTP 416|returned no bytes/,
    );
  });

  it('re-reads a part the origin failed to deliver once', async () => {
    const source = payload(512 * 1024, 11);
    const seen = stubSite({ '/flaky.mp4': { body: source, type: 'video/mp4', flaky: 1 } });

    const { bytes } = await grab('https://site.source.dev/watch/2', 'https://media.source.dev/flaky.mp4');

    expect(bytes).toEqual(source);
    // HEAD, one failed GET, one retried GET.
    expect(seen.filter((entry) => entry.url.includes('flaky'))).toHaveLength(3);
  });

  it('streams a single request when the origin refuses ranges', async () => {
    const source = payload(256 * 1024, 3);
    const seen = stubSite({ '/noranges.mp4': { body: source, type: 'video/mp4', ranges: false } });

    const { bytes } = await grab('https://site.source.dev/watch/3', 'https://media.source.dev/noranges.mp4');

    expect(bytes).toEqual(source);
    // probe, then one plain GET: no range parts, because the host says it cannot do them
    expect(seen.map((entry) => entry.range)).toEqual(['bytes=0-0', null]);
  });

  it('sends the page referer for hotlink-protected media', async () => {
    const source = payload(64 * 1024, 5);
    const seen = stubSite({ '/guarded.mp4': { body: source, type: 'video/mp4' } });

    await grab('https://site.source.dev/watch/9', 'https://media.source.dev/guarded.mp4');

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.referer === 'https://site.source.dev/watch/9')).toBe(true);
  });

  it('refuses a file above the byte budget before downloading it', async () => {
    stubSite({ '/huge.mp4': { body: payload(4 * 1024 * 1024, 2), type: 'video/mp4' } });
    await expect(
      grab('https://site.source.dev/watch/4', 'https://media.source.dev/huge.mp4', { env: env({ GRAB_MAX_VIDEO_BYTES: String(1024 * 1024) }) }),
    ).rejects.toThrow(/above the GRAB_MAX_VIDEO_BYTES budget/);
  });

  it('reports an HTTP error instead of storing the error page', async () => {
    const seen = stubSite({ '/gone.mp4': { body: 'nope', type: 'text/plain', status: 404 } });
    await expect(grab('https://site.source.dev/watch/5', 'https://media.source.dev/gone.mp4')).rejects.toThrow(/404/);
    expect(seen.every((entry) => entry.method !== 'GET' || entry.url.includes('gone'))).toBe(true);
  });

  it('refuses to store an HTML page served under a .mp4 name', async () => {
    stubSite({
      '/login.mp4': { body: '<!doctype html><html><body>Sign in to continue</body></html>', type: 'text/html; charset=utf-8' },
    });
    await expect(grab('https://site.source.dev/watch/13', 'https://media.source.dev/login.mp4')).rejects.toThrow(
      /instead of a media file/,
    );
  });
});

describe('HLS downloads', () => {
  it('picks a variant for the requested quality and concatenates the segments', async () => {
    const source = payload(1024 * 1024 + 3, 21);
    const size = source.byteLength;
    const parts = [0, 1, 2, 3].map((index) => source.subarray((index * size) / 4, ((index + 1) * size) / 4));
    const seen = stubSite({
      '/hls/master.m3u8': {
        body: [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080',
          '1080p.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
          '720p.m3u8',
          '',
        ].join('\n'),
        type: 'application/vnd.apple.mpegurl',
      },
      '/hls/720p.m3u8': {
        body: [
          '#EXTM3U',
          '#EXT-X-TARGETDURATION:6',
          '#EXT-X-PLAYLIST-TYPE:VOD',
          ...parts.flatMap((_, index) => [`#EXTINF:6.000,`, `seg-${index + 1}.ts`]),
          '#EXT-X-ENDLIST',
          '',
        ].join('\n'),
        type: 'application/vnd.apple.mpegurl',
      },
      '/hls/1080p.m3u8': { body: '#EXTM3U\n#EXT-X-ENDLIST\n', type: 'application/vnd.apple.mpegurl' },
      '/hls/seg-1.ts': { body: parts[0]!, type: 'video/mp2t' },
      '/hls/seg-2.ts': { body: parts[1]!, type: 'video/mp2t' },
      '/hls/seg-3.ts': { body: parts[2]!, type: 'video/mp2t' },
      '/hls/seg-4.ts': { body: parts[3]!, type: 'video/mp2t' },
    });

    const { result, bytes } = await grab('https://site.source.dev/watch/6', 'https://media.source.dev/hls/master.m3u8', {
      quality: '720p',
    });

    expect(bytes).toEqual(source);
    expect(result.container).toBe('ts');
    expect(result.contentType).toBe('video/mp2t');
    expect(result.quality).toBe('720p');
    expect(seen.map((entry) => new URL(entry.url).pathname)).toEqual([
      '/hls/master.m3u8',
      '/hls/720p.m3u8',
      '/hls/seg-1.ts',
      '/hls/seg-2.ts',
      '/hls/seg-3.ts',
      '/hls/seg-4.ts',
    ]);
  });

  it('prefixes the CMAF init segment before the media parts', async () => {
    const init = payload(1024, 1);
    const body = payload(3 * 1024, 2);
    stubSite({
      '/cmaf/stream.m3u8': {
        body: ['#EXTM3U', '#EXT-X-TARGETDURATION:8', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:8.000,', 'part-1.m4s', '#EXT-X-ENDLIST', ''].join('\n'),
        type: 'application/vnd.apple.mpegurl',
      },
      '/cmaf/init.mp4': { body: init, type: 'video/mp4' },
      '/cmaf/part-1.m4s': { body, type: 'video/iso.segment' },
    });

    const { result, bytes } = await grab('https://site.source.dev/watch/7', 'https://media.source.dev/cmaf/stream.m3u8');

    expect(result.container).toBe('mp4');
    expect(bytes.subarray(0, init.byteLength)).toEqual(init);
    expect(bytes.subarray(init.byteLength)).toEqual(body);
  });

  it('refuses an encrypted playlist without fetching the key', async () => {
    const seen = stubSite({
      '/enc/media.m3u8': {
        body: ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.source.dev/k"', '#EXTINF:6,', 'seg.ts', '#EXT-X-ENDLIST'].join('\n'),
        type: 'application/vnd.apple.mpegurl',
      },
      '/enc/seg.ts': { body: payload(10, 4), type: 'video/mp2t' },
    });

    await expect(grab('https://site.source.dev/watch/8', 'https://media.source.dev/enc/media.m3u8')).rejects.toThrow(/does not bypass DRM|it is encrypted/);
    expect(seen.map((entry) => new URL(entry.url).pathname)).toEqual(['/enc/media.m3u8']);
  });

  it('refuses a live playlist (no end list)', async () => {
    stubSite({
      '/live/media.m3u8': { body: ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:10', '#EXTINF:6,', 'seg.ts'].join('\n'), type: 'application/vnd.apple.mpegurl' },
    });
    await expect(grab('https://site.source.dev/watch/10', 'https://media.source.dev/live/media.m3u8')).rejects.toThrow(/no #EXT-X-ENDLIST/);
  });
});

describe('DASH downloads', () => {
  it('expands a SegmentTemplate manifest into segment fetches', async () => {
    const init = payload(512, 8);
    const a = payload(1500, 9);
    const b = payload(1700, 10);
    stubSite({
      '/dash/manifest.mpd': {
        body: `<MPD type="static" mediaPresentationDuration="PT4S" xmlns="urn:mpeg:dash:schema:mpd:2011">
          <Period><AdaptationSet mimeType="video/mp4">
            <SegmentTemplate initialization="init.mp4" media="seg-$Number$.m4s" timescale="1000" startNumber="1">
              <SegmentTimeline><S d="2000"/><S d="2000"/></SegmentTimeline>
            </SegmentTemplate>
            <Representation id="v" bandwidth="1200000" width="1280" height="720"/>
          </AdaptationSet></Period></MPD>`,
        type: 'application/dash+xml',
      },
      '/dash/init.mp4': { body: init, type: 'video/mp4' },
      '/dash/seg-1.m4s': { body: a, type: 'video/iso.segment' },
      '/dash/seg-2.m4s': { body: b, type: 'video/iso.segment' },
    });

    const { result, bytes } = await grab('https://site.source.dev/watch/11', 'https://media.source.dev/dash/manifest.mpd');

    expect(bytes).toEqual(concat([init, a, b]));
    expect(result.container).toBe('mp4');
    expect(result.quality).toBe('720p');
  });

  it('refuses a manifest that declares DRM', async () => {
    stubSite({
      '/drm/manifest.mpd': {
        body: `<MPD type="static"><Period><AdaptationSet>
          <ContentProtection schemeIdUri="urn:mpeg:dash:oipf:cenc"/>
          <SegmentTemplate media="seg-$Number$.m4s" initialization="i.mp4"><SegmentTimeline><S d="1"/></SegmentTimeline></SegmentTemplate>
          <Representation id="a" bandwidth="1"/>
        </AdaptationSet></Period></MPD>`,
        type: 'application/dash+xml',
      },
    });
    await expect(grab('https://site.source.dev/watch/12', 'https://media.source.dev/drm/manifest.mpd')).rejects.toThrow(/protected|DRM/);
  });
});
