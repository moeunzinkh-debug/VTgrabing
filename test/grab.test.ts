import { describe, expect, it, vi } from 'vitest';
import { checkHostname, isPrivateIpv4, isPrivateIpv6, parseIpv6, safeUrl } from '../src/grab/guard';
import { grabConfig } from '../src/grab/config';
import { orderHintFromUrl, sniffDocument, titleFromUrl, dedupeCandidates } from '../src/grab/sniff';
import { buildPackedHls, expandTemplate, parseDashManifest, parseHlsPlaylist, parseIsoDuration, pickVariant } from '../src/grab/manifests';
import { normalizeQualityLabel, qualityLabelForHeight, resolveFormat } from '../src/grab/media-types';
import { groupKeyFor, HttpSniffExtractor } from '../src/providers/extract/http-sniff';
import { badRequest } from '../src/core/errors';
import type { Env } from '../src/env';
import type { GrabConfig } from '../src/grab/config';
import { Budget } from '../src/grab/net';
import { testEnv } from './helpers';

/**
 * Unit tests for the real link grabber (`src/grab/*`).
 *
 * They cover the three things that must be right for the flow to be more than a
 * demo: which hosts we are allowed to open, what we extract from a page, and how
 * HLS/DASH manifests turn into qualities, segments and an encryption verdict.
 */

function cfg(overrides: Partial<GrabConfig> = {}): GrabConfig {
  return { ...grabConfig(testEnv as Env), ...overrides };
}

const html = (body: string, url = 'https://video.source.dev/watch/42') =>
  sniffDocument(body, new URL(url), { depth: 0, maxCandidates: 100 });

describe('host policy (SSRF guard)', () => {
  // Pinned, so the assertions cannot be softened by a local .dev.vars override.
  const config = cfg({ allowPrivateHosts: false });

  it('refuses every private, link-local and reserved address', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '100.64.0.1',
      '169.254.169.254',
      '172.16.9.9',
      '192.168.1.10',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '0.0.0.0',
    ]) {
      expect(checkHostname(host, config).ok, host).toBe(false);
    }
    expect(isPrivateIpv4([8, 8, 8, 8])).toBe(false);
    expect(isPrivateIpv4([169, 254, 169, 254])).toBe(true);
  });

  it('parses IPv6 literals and refuses the reserved ranges', () => {
    expect(parseIpv6('::1')).toMatchObject({ 15: 1 });
    expect(parseIpv6('2001:db8::1')).not.toBeNull();
    expect(parseIpv6('gggg::1')).toBeNull();
    expect(isPrivateIpv6(parseIpv6('::1')!)).toBe(true);
    expect(isPrivateIpv6(parseIpv6('fe80::1')!)).toBe(true);
    expect(isPrivateIpv6(parseIpv6('fd12::1')!)).toBe(true);
    expect(isPrivateIpv6(parseIpv6('ff02::1')!)).toBe(true);
    expect(isPrivateIpv6(parseIpv6('::ffff:192.168.0.1')!)).toBe(true);
    expect(isPrivateIpv6(parseIpv6('2606:4700:4700::1111')!)).toBe(false);
  });

  it('refuses internal names, and reserved pseudo TLDs', () => {
    for (const host of ['localhost', 'metadata.google.internal', 'db.local', 'api.test', 'x.internal', 'singlelabel']) {
      expect(checkHostname(host, config).ok).toBe(false);
    }
    expect(checkHostname('video.source.dev.com', config).ok).toBe(true);
  });

  it('honours the operator allow-list and deny-list', () => {
    const allowed = cfg({ allowlist: ['source.dev'] });
    expect(checkHostname('video.source.dev', allowed).ok).toBe(true);
    // refused twice over: not on the list and a reserved name
    expect(checkHostname('evil.test', allowed).ok).toBe(false);
    expect(checkHostname('other.host.dev', allowed).ok).toBe(false);
    const denied = cfg({ denylist: ['cdn.source.dev'] });
    expect(checkHostname('cdn.source.dev', denied).ok).toBe(false);
    expect(checkHostname('other.source.dev', denied).ok).toBe(true);
  });

  it('only lets a development runtime target loopback', () => {
    const dev = cfg({ allowPrivateHosts: true });
    expect(checkHostname('127.0.0.1', dev).ok).toBe(true);
    expect(safeUrl('http://127.0.0.1:8099/x.mp4', dev).url.pathname).toBe('/x.mp4');
    expect(() => safeUrl('http://127.0.0.1:8099/x.mp4', config)).toThrow(/private\/reserved/);
  });

  it('rejects credentials, non-http schemes and keeps a usable message', () => {
    expect(() => safeUrl('ftp://example.com/a.mp4', config)).toThrow(/http and https/);
    expect(() => safeUrl('https://user:pass@example.com/a.mp4', config)).toThrow(/Credentials/);
    expect(() => safeUrl('not a url', config)).toThrow(/Not a usable URL/);
  });
});

describe('page sniffing', () => {
  it('finds <video>, <source>, data attributes, og:video and anchor links', () => {
    const result = html(`
      <video src="/media/a.mp4" poster="/p.jpg" data-title="Trailer"></video>
      <video><source src="/media/b.webm" type="video/webm" label="720p" /></video>
      <meta property="og:video" content="https://cdn.example.com/c.m3u8" />
      <a href="/media/ep-01.mp4">Episode 1</a>
      <div data-hls="https://cdn.example.com/d/index.m3u8"></div>
    `);
    const urls = result.candidates.map((candidate) => candidate.url).sort();
    expect(urls).toEqual(
      [
        'https://cdn.example.com/c.m3u8',
        'https://cdn.example.com/d/index.m3u8',
        'https://video.source.dev/media/a.mp4',
        'https://video.source.dev/media/b.webm',
        'https://video.source.dev/media/ep-01.mp4',
      ].sort(),
    );
    const anchor = result.candidates.find((candidate) => candidate.url.endsWith('/media/ep-01.mp4'));
    expect(anchor?.title).toBe('Episode 1');
    const source = result.candidates.find((candidate) => candidate.url.endsWith('b.webm'));
    expect(source?.container).toBe('webm');
    expect(source?.quality).toBe('720p');
    expect(result.candidates.find((candidate) => candidate.url.endsWith('c.m3u8'))?.kind).toBe('hls');
  });

  it('reads player config blobs and JSON-LD, including escaped slashes', () => {
    const result = html(`
      <script>
        var player = { sources: [
          { file: "\\/media\\/hd.mp4", label: "1080p" },
          { file: "https://cdn.source.dev/slow.m3u8", "res": "1280x720", bandwidth: 2600000 }
        ] };
      </script>
      <script type="application/ld+json">
        {"@type":"VideoObject","name":"Feature","contentUrl":"https://cdn.source.dev/feature.mp4"}
      </script>
    `);
    const hd = result.candidates.find((candidate) => candidate.url.endsWith('/media/hd.mp4'));
    expect(hd?.url).toBe('https://video.source.dev/media/hd.mp4');
    expect(hd?.quality).toBe('1080p');
    const adaptive = result.candidates.find((candidate) => candidate.url.endsWith('slow.m3u8'));
    expect(adaptive?.kind).toBe('hls');
    expect(adaptive?.height).toBe(720);
    const jsonLd = result.candidates.find((candidate) => candidate.url.endsWith('feature.mp4'));
    expect(jsonLd?.title).toBe('Feature');
  });

  it('decodes HTML entities and protocol relative URLs', () => {
    const result = html(
      `<a href="//cdn.source.dev/v&amp;1.mp4">both</a><video src="/v?a=1&amp;b=2.mp4"></video>`,
      'https://example.org/watch',
    );
    expect(result.candidates.map((candidate) => candidate.url)).toContain('https://cdn.source.dev/v&1.mp4');
  });

  it('collects every media URL from a JSON API response', () => {
    const body = JSON.stringify({
      data: [
        { title: 'One', streams: { hls: '/hls/1.m3u8', mp4: 'https://cdn.source.dev/1.mp4' } },
        { title: 'Two', streams: { mp4: 'https://cdn.source.dev/2.mp4' }, duration: 12 },
      ],
    });
    const result = sniffDocument(body, new URL('https://api.source.dev/v1/episodes.json'), { depth: 0 });
    const urls = result.candidates.map((candidate) => candidate.url);
    expect(urls).toContain('https://cdn.source.dev/1.mp4');
    expect(urls).toContain('https://cdn.source.dev/2.mp4');
    expect(urls).toContain('https://api.source.dev/hls/1.m3u8');
  });

  it('separates episode links and embedded players from media links', () => {
    const result = html(`
      <a href="/episode/5">Episode 5</a>
      <a href="/episode-6-watching">Episode 6</a>
      <a href="/about">About us</a>
      <iframe src="/player/embed/99"></iframe>
      <video src="/real.mp4"></video>
    `);
    expect(result.episodeLinks).toEqual(expect.arrayContaining(['/episode/5', '/episode-6-watching']));
    expect(result.episodeLinks).not.toContain('/about');
    expect(result.embeds).toEqual(['/player/embed/99']);
    expect(result.candidates.map((candidate) => candidate.url)).toEqual(['https://video.source.dev/real.mp4']);
  });

  it('ignores non-media URLs and dedupes with the richest metadata', () => {
    const result = html(`<a href="/app.js">js</a><a href="/notes.txt">txt</a><a href="/real.mp4">x</a>`, 'https://example.com/p');
    expect(result.candidates).toHaveLength(1);
    const deduped = dedupeCandidates([
      { ...result.candidates[0]!, foundBy: 'raw-scan', title: undefined },
      { ...result.candidates[0]!, foundBy: 'video-tag', title: 'From tag' },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].foundBy).toBe('video-tag');
    expect(deduped[0].title).toBe('From tag');
  });

  it('derives titles and order from file names', () => {
    expect(titleFromUrl('https://x/EP-07_The-Harbor.mp4')).toMatch(/Harbor/i);
    expect(orderHintFromUrl('https://x/season1/episode-0012.mp4')).toBe(12);
    expect(orderHintFromUrl('https://x/watch?episode=3')).toBe(3);
    expect(orderHintFromUrl('https://x/watch?id=77')).toBeUndefined();
  });
});

describe('HLS + DASH manifests', () => {
  const base = 'https://cdn.source.dev/video/';

  it('reads master playlists and maps variants to quality labels', () => {
    const { master } = parseHlsPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=5200000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
        '1080p.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
        '360p.m3u8',
      ].join('\n'),
      new URL(`${base}master.m3u8`),
    );
    expect(master.isMaster).toBe(true);
    expect(master.variants.map((variant) => variant.resolution?.height)).toEqual([1080, 360]);
    expect(pickVariant(master.variants, '720p')?.url).toBe(`${base}360p.m3u8`);
    expect(pickVariant(master.variants, 'source')?.url).toBe(`${base}1080p.m3u8`);
    expect(qualityLabelForHeight(2160)).toBe('2160p');
    expect(qualityLabelForHeight(1080)).toBe('1080p');
    expect(qualityLabelForHeight(480)).toBe('480p');
    expect(qualityLabelForHeight(undefined, 2_600_000)).toBe('720p');
    expect(qualityLabelForHeight(undefined, 5_200_000)).toBe('1080p');
  });

  it('reads media playlists: segments, init map, duration and end list', () => {
    const { media } = parseHlsPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:6',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:6.006,',
        'seg-1.m4s',
        '#EXTINF:5.994,',
        'seg-2.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      new URL(`${base}media.m3u8`),
    );
    expect(media?.segments.map((segment) => segment.url)).toEqual([`${base}seg-1.m4s`, `${base}seg-2.m4s`]);
    expect(media?.initSegment).toBe(`${base}init.mp4`);
    const packed = buildPackedHls(media!, `${base}media.m3u8`);
    expect(packed.container).toBe('mp4');
    expect(packed.live).toBe(false);
    expect(packed.durationSeconds).toBe(12);
  });

  it('detects encryption instead of trying to use it', () => {
    const { media } = parseHlsPlaylist(
      ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key"', '#EXTINF:6,', 'seg.ts', '#EXT-X-ENDLIST'].join('\n'),
      new URL(`${base}media.m3u8`),
    );
    expect(media?.encryption?.method).toBe('AES-128');
    expect(media?.encryption?.uri).toBe('https://k.example/key');
    const packed = buildPackedHls(media!, `${base}media.m3u8`);
    expect(packed.encryption?.method).toBe('AES-128');
  });

  it('flags live playlists (no #EXT-X-ENDLIST) as not grabbable', () => {
    const { media } = parseHlsPlaylist(['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:10', '#EXTINF:6,', 'a.ts'].join('\n'), new URL(`${base}live.m3u8`));
    expect(buildPackedHls(media!, `${base}live.m3u8`).live).toBe(true);
  });

  it('honours #EXT-X-BYTERANGE segments', () => {
    const { media } = parseHlsPlaylist(
      ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6,', '#EXT-X-BYTERANGE:1024@0', 'big.mp4', '#EXTINF:6,', '#EXT-X-BYTERANGE:1024@1024', 'big.mp4', '#EXT-X-ENDLIST'].join(
        '\n',
      ),
      new URL(`${base}media.m3u8`),
    );
    expect(media?.segments.map((segment) => segment.byteRange)).toEqual([
      { length: 1024, start: 0 },
      { length: 1024, start: 1024 },
    ]);
  });

  it('expands DASH SegmentTemplate + SegmentTimeline into real URLs', () => {
    const manifest = parseDashManifest(
      `<?xml version="1.0"?>
       <MPD type="static" mediaPresentationDuration="PT12S">
         <Period>
           <AdaptationSet mimeType="video/mp4">
             <SegmentTemplate initialization="init-$RepresentationID$.mp4" media="seg-$Number%05d$.m4s" timescale="1000" startNumber="1">
               <SegmentTimeline><S t="0" d="6000" r="1"/></SegmentTimeline>
             </SegmentTemplate>
             <Representation id="v1" bandwidth="4000000" width="1920" height="1080"/>
           </AdaptationSet>
         </Period>
       </MPD>`,
      new URL(`${base}manifest.mpd`),
    );
    const representation = manifest.representations[0]!;
    expect(representation.segmentUrls).toEqual([`${base}seg-00001.m4s`, `${base}seg-00002.m4s`]);
    expect(representation.initUrl).toBe(`${base}init-v1.mp4`);
    expect(representation.height).toBe(1080);
    expect(manifest.durationSeconds).toBe(12);
    expect(parseIsoDuration('PT1H2M3.5S')).toBe(3724); // rounded to whole seconds
  });

  it('reads DASH SegmentList and refuses ContentProtection', () => {
    const withList = parseDashManifest(
      `<MPD type="static"><Period><AdaptationSet>
         <Representation id="a" bandwidth="100">
           <SegmentList duration="4000" timescale="1000">
             <Initialization sourceURL="init.mp4"/>
             <SegmentURL media="s1.m4s"/><SegmentURL media="s2.m4s"/>
           </SegmentList>
         </Representation>
       </AdaptationSet></Period></MPD>`,
      new URL(`${base}manifest.mpd`),
    );
    expect(withList.representations[0]?.segmentUrls).toEqual([`${base}s1.m4s`, `${base}s2.m4s`]);
    expect(withList.representations[0]?.initUrl).toBe(`${base}init.mp4`);

    const drm = parseDashManifest(
      `<MPD><Period><AdaptationSet>
         <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27d69b85d80d"/>
         <SegmentTemplate media="seg-$Number$.m4s" initialization="i.m4s"/>
         <Representation id="a" bandwidth="1"><SegmentTimeline><S d="1"/></SegmentTimeline></Representation>
       </AdaptationSet></Period></MPD>`,
      new URL(`${base}manifest.mpd`),
    );
    expect(drm.encryption?.drm).toContain('Widevine');
  });

  it('expands templates for padding and unknown placeholders', () => {
    expect(expandTemplate('a$Number$-$Time$.mp4', { Number: 3, Time: 90 })).toBe('a3-90.mp4');
    expect(expandTemplate('x-$Missing$.mp4', { Number: 1 })).toBe('x-$Missing$.mp4');
  });
});

describe('container + quality decisions', () => {
  it('classifies by extension first, then by content type', () => {
    expect(resolveFormat('/a/b.mp4')).toMatchObject({ kind: 'progressive', container: 'mp4' });
    expect(resolveFormat('/a/b.m3u8')).toMatchObject({ kind: 'hls', manifest: true });
    expect(resolveFormat('/a/b.mpd')).toMatchObject({ kind: 'dash', manifest: true });
    expect(resolveFormat('/stream', 'application/vnd.apple.mpegurl')).toMatchObject({ kind: 'hls' });
    expect(resolveFormat('/stream', 'video/webm')).toMatchObject({ container: 'webm' });
    expect(resolveFormat('/page.html')).toBeNull();
    expect(normalizeQualityLabel('Full HD')).toBe('1080p');
    expect(normalizeQualityLabel('1280x720')).toBe('720p');
    expect(normalizeQualityLabel(undefined, 'source')).toBe('source');
  });

  it('groups renditions of one video but keeps different videos apart', () => {
    const candidate = (url: string) => sniffDocument(`<video src="${url}"></video>`, new URL('https://x.test/p')).candidates[0]!;
    const high = candidate('https://cdn.source.dev/movie/ep1-1080p.mp4');
    const low = candidate('https://cdn.source.dev/movie/ep1-720p.mp4');
    const other = candidate('https://cdn.source.dev/movie/ep2.mp4');
    expect(groupKeyFor(high)).toBe(groupKeyFor(low));
    expect(groupKeyFor(high)).not.toBe(groupKeyFor(other));
  });
});

describe('extractor eligibility', () => {
  const extractor = new HttpSniffExtractor();
  const offline = { GRAB_ALLOW_PRIVATE_HOSTS: 'false' } as const;

  it('is off when GRAB_ENABLED=false and on by default', () => {
    expect(extractor.isConfigured({ ...testEnv, GRAB_ENABLED: 'false' } as Env)).toBe(false);
    expect(extractor.isConfigured({ ...testEnv, GRAB_ENABLED: 'true' } as Env)).toBe(true);
  });

  it('does not claim mock-only hosts, so the mock catalog still works', () => {
    const env = { ...testEnv, ...offline, GRAB_ENABLED: 'true' } as Env;
    expect(extractor.canHandle(new URL('https://mock.local/series/a'), env)).toBe(false);
    expect(extractor.canHandle(new URL('https://video.source.dev/watch/1'), env)).toBe(true);
    expect(extractor.canHandle(new URL('ftp://video.source.dev/a'), env)).toBe(false);
  });

  it('respects the allow-list', () => {
    const env = { ...testEnv, ...offline, GRAB_ENABLED: 'true', GRAB_ALLOWED_HOSTS: 'video.source.dev' } as Env;
    expect(extractor.canHandle(new URL('https://video.source.dev/watch/1'), env)).toBe(true);
    expect(extractor.canHandle(new URL('https://other.example/watch/1'), env)).toBe(false);
  });

  it('explains what it found when the page has no media', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<html><body><p>nothing here</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const error = await new HttpSniffExtractor()
      .extract(new URL('https://empty.source.dev/page'), { ...testEnv, ...offline, GRAB_ENABLED: 'true' } as Env)
      .catch((thrown: unknown) => thrown);
    expect(badRequest('x').status).toBe(400);
    expect((error as { message: string }).message).toMatch(/found no publicly reachable video source/);
    expect((error as { details: { diagnostics: string[] } }).details.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('download budget', () => {
  it('stops after the configured number of sub-requests', () => {
    const budget = new Budget(2);
    budget.take();
    budget.take();
    expect(() => budget.take()).toThrow(/sub-requests exhausted/);
  });
});
