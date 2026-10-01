import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { grabConfig } from '../src/grab/config';
import { Budget } from '../src/grab/net';
import {
  analyzeVideo,
  canonicalVideoUrl,
  classify,
  cleanTitle,
  findVideoRefInHtml,
  findVideoRefInUrl,
  inspectVideoPage,
  isGenericTikTokText,
  isShortTikTokUrl,
  linkOnlyInfo,
  normalizeDigits,
  parseEpisodeMarker,
  parseOEmbed,
  parseTikTokUrl,
  parseVideoPage,
} from '../src/grab/tiktok';
import { resolveExtractor } from '../src/providers/extract/registry';
import { mergeInfo, resolveShortLink, resolveShortUrl, TikTokExtractor } from '../src/providers/extract/tiktok';
import { isListOnly } from '../src/jobs/service';
import { app } from '../src/routes/api';
import { postJson, repository, testEnv } from './helpers';
import type { EpisodeRecord } from '../src/shared/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const env = (overrides: Record<string, string> = {}): Env =>
  ({ ...testEnv, GRAB_ENABLED: 'true', GRAB_ALLOW_PRIVATE_HOSTS: 'false', ...overrides }) as Env;

// ---------------------------------------------------------------------------
// fixtures: the shape of TikTok's public page data, reduced to what we read
// ---------------------------------------------------------------------------

function pageHtml(itemStruct: Record<string, unknown>, extraScope: Record<string, unknown> = {}): string {
  const data = {
    __DEFAULT_SCOPE__: {
      'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct } },
      ...extraScope,
    },
  };
  return `<html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></head><body></body></html>`;
}

const DRAMA_ID = '7300000000000000012';
const dramaItem = {
  id: DRAMA_ID,
  desc: 'The Billionaire\'s Secret Wife EP 12/60 #minidrama #fyp',
  createTime: 1_760_000_000,
  author: { uniqueId: 'dramahouse', nickname: 'Drama House' },
  video: { duration: 91, cover: 'https://p16.example-cdn.com/cover12.jpg' },
  playlistId: '7999',
};
const dramaScope = {
  'webapp.playlist-detail': {
    playlist: {
      id: '7999',
      name: "The Billionaire's Secret Wife",
      videoCount: 3,
      itemList: [
        { id: '7300000000000000010', desc: 'The Billionaire\'s Secret Wife EP 10', author: { uniqueId: 'dramahouse' }, video: { duration: 80 } },
        { id: '7300000000000000011', desc: 'The Billionaire\'s Secret Wife EP 11', author: { uniqueId: 'dramahouse' }, video: { duration: 85 } },
        { id: DRAMA_ID, desc: dramaItem.desc, author: { uniqueId: 'dramahouse' }, video: { duration: 91 } },
      ],
    },
  },
};

const normalItem = {
  id: '7111111111111111111',
  desc: 'my cat learns to open doors #cat #fyp',
  author: { uniqueId: 'catlady', nickname: 'Cat Lady' },
  video: { duration: 14, cover: 'https://p16.example-cdn.com/c.jpg' },
};

// ---------------------------------------------------------------------------

describe('TikTok URLs', () => {
  it('recognizes short links and reads long ones', () => {
    expect(isShortTikTokUrl(new URL('https://vm.tiktok.com/ZMabc123/'))).toBe(true);
    expect(isShortTikTokUrl(new URL('https://vt.tiktok.com/ZSabc123/'))).toBe(true);
    expect(isShortTikTokUrl(new URL('https://www.tiktok.com/t/ZTabc123/'))).toBe(true);
    expect(isShortTikTokUrl(new URL('https://www.tiktok.com/@a/video/7300000000000000012'))).toBe(false);
    expect(parseTikTokUrl(new URL('https://www.tiktok.com/@drama.house/video/7300000000000000012?_r=1'))).toEqual({
      username: 'drama.house',
      videoId: '7300000000000000012',
      kind: 'video',
    });
    expect(parseTikTokUrl(new URL('https://www.tiktok.com/@drama.house')).kind).toBe('profile');
    expect(canonicalVideoUrl('@x', '7300000000000000012')).toBe('https://www.tiktok.com/@x/video/7300000000000000012');
  });
});

describe('episode numbers', () => {
  it.each([
    ['Secret Wife EP 12/60 #minidrama', 12, 60],
    ['Episode 5', 5, undefined],
    ['Part 3 of 10', 3, 10],
    ['ep.07', 7, undefined],
    ['Tập 9', 9, undefined],
    ['វគ្គ ១២', 12, undefined],
    ['第8集', 8, undefined],
    ['Capítulo 4', 4, undefined],
  ])('reads "%s"', (text, number, total) => {
    const marker = parseEpisodeMarker(text);
    expect(marker?.number).toBe(number);
    expect(marker?.total).toBe(total);
  });

  it('does not invent a number', () => {
    expect(parseEpisodeMarker('my cat learns to open doors #cat')).toBeNull();
    expect(parseEpisodeMarker('Best part of my day')).toBeNull();
    expect(parseEpisodeMarker('')).toBeNull();
    expect(normalizeDigits('០១២៣៤៥៦៧៨៩')).toBe('0123456789');
  });

  it('cleans captions into titles', () => {
    expect(cleanTitle(dramaItem.desc)).toBe("The Billionaire's Secret Wife");
    expect(cleanTitle('#fyp #viral')).toBe('');
  });
});

describe('mini-drama or normal video', () => {
  it('reads the public page JSON', () => {
    const info = parseVideoPage(pageHtml(dramaItem, dramaScope), new URL(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`));
    expect(info?.origin).toBe('page-json');
    expect(info?.username).toBe('dramahouse');
    expect(info?.durationSeconds).toBe(91);
    expect(info?.hashtags).toContain('minidrama');
    expect(info?.playlist?.items).toHaveLength(3);
    expect(info?.playlist?.name).toBe("The Billionaire's Secret Wife");
  });

  it('classifies a series with a playlist, tag and episode marker as a mini-drama', () => {
    const info = parseVideoPage(pageHtml(dramaItem, dramaScope), new URL('https://www.tiktok.com/@dramahouse/video/' + DRAMA_ID))!;
    const verdict = classify(info);
    expect(verdict.kind).toBe('mini-drama');
    expect(verdict.confidence).toBe('high');
    expect(verdict.signals.join(' ')).toMatch(/#minidrama/);
    expect(verdict.signals.join(' ')).toMatch(/playlist/);
    expect(verdict.signals.join(' ')).toMatch(/EP 12/);
  });

  it('classifies an ordinary clip as a normal video', () => {
    const info = parseVideoPage(pageHtml(normalItem), new URL('https://www.tiktok.com/@catlady/video/7111111111111111111'))!;
    const verdict = classify(info);
    expect(verdict.kind).toBe('normal-video');
    expect(verdict.confidence).toBe('high');
  });

  it('does not call a single "Part 2" clip or a lone #drama a mini-drama', () => {
    const one = classify({ caption: 'Part 2 of my trip', hashtags: [], origin: 'meta' });
    expect(one.kind).toBe('normal-video');
    const tag = classify({ caption: 'so much drama today #drama', hashtags: ['drama'], origin: 'meta' });
    expect(tag.kind).toBe('normal-video');
    // a generic #drama plus a marker is still not enough; a specific tag plus a marker is
    const both = classify({ caption: 'EP 2 #drama', hashtags: ['drama'], origin: 'meta' });
    expect(both.kind).toBe('normal-video');
    expect(classify({ caption: 'EP 2 #shortmax', hashtags: ['shortmax'], origin: 'meta' }).kind).toBe('mini-drama');
  });

  it('builds the episode list, in order, with the number and the user\'s own episode marked', () => {
    const info = parseVideoPage(pageHtml(dramaItem, dramaScope), new URL('https://www.tiktok.com/@dramahouse/video/' + DRAMA_ID))!;
    const analysis = analyzeVideo(info);
    expect(analysis.kind).toBe('mini-drama');
    expect(analysis.title).toBe("The Billionaire's Secret Wife");
    expect(analysis.currentEpisodeNumber).toBe(12);
    expect(analysis.totalEpisodes).toBe(60);
    expect(analysis.episodes.map((episode) => episode.episodeNumber)).toEqual([10, 11, 12]);
    expect(analysis.episodes.map((episode) => episode.index)).toEqual([1, 2, 3]);
    expect(analysis.episodes.filter((episode) => episode.current).map((episode) => episode.videoId)).toEqual([DRAMA_ID]);
    expect(analysis.episodes[0].url).toBe('https://www.tiktok.com/@dramahouse/video/7300000000000000010');
    // 3 of 60: the tool must say the list is partial rather than pretend it is whole
    expect(analysis.listComplete).toBe(false);
    expect(analysis.listNote).toMatch(/3 of 60|authorized source/);
  });

  it('lists just the one episode, and says so, when the page exposes no playlist', () => {
    const item = { ...dramaItem, playlistId: undefined };
    const analysis = analyzeVideo(parseVideoPage(pageHtml(item), new URL('https://www.tiktok.com/@dramahouse/video/' + DRAMA_ID))!);
    expect(analysis.kind).toBe('mini-drama');
    expect(analysis.episodes).toHaveLength(1);
    expect(analysis.episodes[0].episodeNumber).toBe(12);
    expect(analysis.listComplete).toBe(false);
    expect(analysis.listNote).toMatch(/authorized source/);
  });

  it('falls back to Open Graph tags and to oEmbed', () => {
    const meta = parseVideoPage(
      '<meta property="og:description" content="Secret Wife EP 3 #minidrama #shortmax" /><meta property="og:image" content="https://x.example/i.jpg">',
      new URL('https://www.tiktok.com/@dramahouse/video/' + DRAMA_ID),
    );
    expect(meta?.origin).toBe('meta');
    expect(meta?.hashtags).toEqual(['minidrama', 'shortmax']);
    const oembed = parseOEmbed(
      { title: 'hello #cat', author_name: 'Cat Lady', author_url: 'https://www.tiktok.com/@catlady', thumbnail_url: 'https://x.example/t.jpg', embed_product_id: '7111111111111111111' },
      new URL('https://www.tiktok.com/@catlady/video/7111111111111111111'),
    );
    expect(oembed?.username).toBe('catlady');
    expect(oembed?.id).toBe('7111111111111111111');
    expect(parseOEmbed({ error: 'nope' }, new URL('https://www.tiktok.com/'))).toBeNull();
  });

  it('returns null for a page with nothing in it (bot check)', () => {
    expect(parseVideoPage('<html><title>Verify</title></html>', new URL('https://www.tiktok.com/@a/video/7300000000000000012'))).toBeNull();
  });

  it('recovers the video id from the oEmbed html field when the url is a short link', () => {
    // TikTok's real oEmbed response carries no id field; the embed snippet names the video.
    const html =
      `<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}" ` +
      `data-video-id="${DRAMA_ID}"><section><a href="https://www.tiktok.com/@dramahouse?referer=embed">@dramahouse</a></section></blockquote>`;
    const oembed = parseOEmbed(
      { title: 'Secret Wife EP 4 #minidrama', author_name: 'Drama House', author_url: 'https://www.tiktok.com/@dramahouse', thumbnail_url: 'https://x.example/t.jpg', html },
      new URL('https://vt.tiktok.com/ZSbADyPoy/'),
    );
    expect(oembed?.id).toBe(DRAMA_ID);
    expect(oembed?.username).toBe('dramahouse');
    expect(oembed?.origin).toBe('oembed');
  });

  it('recovers the video id from og:url when the page url is an unresolved short link', () => {
    const html =
      `<meta property="og:url" content="https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}">` +
      '<meta property="og:description" content="Secret Wife EP 4 #minidrama #shortmax">';
    const meta = parseVideoPage(html, new URL('https://vt.tiktok.com/ZSbADyPoy/'));
    expect(meta?.origin).toBe('meta');
    expect(meta?.id).toBe(DRAMA_ID);
    expect(meta?.username).toBe('dramahouse');
  });
});

describe('short URL resolution', () => {
  const cfg = grabConfig(env());

  it('follows vm.tiktok.com to the long URL and strips tracking parameters', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: `https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}?_r=1&u_code=abc&share_app_id=1233` },
      });
    });
    const trace: string[] = [];
    const resolved = await resolveShortUrl(new URL('https://vm.tiktok.com/ZMabc123/'), cfg, undefined, new Budget(10), (line) => trace.push(line));
    expect(resolved.toString()).toBe(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
    expect(seen).toEqual(['https://vm.tiktok.com/ZMabc123/']);
    expect(trace[0]).toMatch(/short link hop 1/);
  });

  it('refuses a short link that redirects off TikTok', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }));
    await expect(resolveShortUrl(new URL('https://vm.tiktok.com/ZMevil/'), cfg, undefined, new Budget(10), () => undefined)).rejects.toThrow(/not TikTok/);
  });

  it('leaves a long URL alone (no request at all)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const resolved = await resolveShortUrl(new URL(`https://www.tiktok.com/@a/video/${DRAMA_ID}?lang=en`), cfg, undefined, new Budget(10), () => undefined);
    expect(resolved.search).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sniffs the long URL out of a 200 interstitial page (no redirect hop)', async () => {
    const html =
      `<html><head><meta property="og:url" content="https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}"></head>` +
      '<body>Opening TikTok…</body></html>';
    vi.stubGlobal('fetch', async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
    const resolved = await resolveShortUrl(new URL('https://vt.tiktok.com/ZSbADyPoy/'), cfg, undefined, new Budget(10), () => undefined);
    expect(resolved.toString()).toBe(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
  });

  it('reports a bot-checked hop in the trace instead of pretending it resolved', async () => {
    const trace: string[] = [];
    vi.stubGlobal('fetch', async () => new Response('captcha', { status: 403 }));
    const resolved = await resolveShortUrl(new URL('https://vt.tiktok.com/ZSbADyPoy/'), cfg, undefined, new Budget(10), (line) => trace.push(line));
    expect(resolved.toString()).toBe('https://vt.tiktok.com/ZSbADyPoy/');
    expect(trace.join('\n')).toMatch(/HTTP 403/);
  });

  it('does not self-declare a bot in the default user agent', () => {
    expect(grabConfig(env()).userAgent).not.toMatch(/vtgrab/i);
  });
});

describe('TikTokExtractor end to end (stubbed network)', () => {
  function stubTikTok(handler: (url: URL) => Response | undefined) {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      seen.push(url.toString());
      if (url.hostname === 'vm.tiktok.com') {
        return new Response(null, { status: 302, headers: { location: `https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}?_r=1` } });
      }
      return handler(url) ?? new Response('not found', { status: 404 });
    });
    return seen;
  }

  it('paste short URL -> resolved -> mini-drama -> title, episode number, list', async () => {
    stubTikTok((url) =>
      url.pathname.includes('/video/') ? new Response(pageHtml(dramaItem, dramaScope), { headers: { 'content-type': 'text/html' } }) : undefined,
    );
    const series = await new TikTokExtractor().extract(new URL('https://vm.tiktok.com/ZMabc123/'), env());
    expect(series.sourceKey).toBe('tiktok');
    expect(series.title).toBe("The Billionaire's Secret Wife");
    expect(series.canonicalUrl).toBe('tiktok:playlist:7999');
    expect(series.metadata).toMatchObject({
      contentKind: 'mini-drama',
      confidence: 'high',
      currentEpisodeNumber: 12,
      totalEpisodes: 60,
      listComplete: false,
      resolvedUrl: `https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`,
    });
    expect(series.episodes.map((episode) => episode.metadata?.episodeNumber)).toEqual([10, 11, 12]);
    // listing only: no media URLs are ever produced
    expect(series.episodes.every((episode) => episode.streams.length === 0 && episode.metadata?.listOnly === true)).toBe(true);
  });

  it('a normal video becomes a one-item list', async () => {
    stubTikTok(() => new Response(pageHtml(normalItem), { headers: { 'content-type': 'text/html' } }));
    const series = await new TikTokExtractor().extract(new URL('https://www.tiktok.com/@catlady/video/7111111111111111111'), env());
    expect(series.metadata).toMatchObject({ contentKind: 'normal-video', listComplete: true });
    expect(series.title).toBe('my cat learns to open doors');
    expect(series.episodes).toHaveLength(1);
    expect(series.canonicalUrl).toBe('tiktok:video:7111111111111111111');
  });

  it('uses public oEmbed when the page is walled, and never tries to get past the wall', async () => {
    const seen = stubTikTok((url) => {
      if (url.pathname === '/oembed') {
        return Response.json({ title: 'Secret Wife EP 4 #minidrama #reelshort', author_name: 'Drama House', author_url: 'https://www.tiktok.com/@dramahouse', thumbnail_url: 'https://x.example/t.jpg' });
      }
      return new Response('captcha', { status: 403 });
    });
    const series = await new TikTokExtractor().extract(new URL(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`), env());
    expect(series.metadata?.dataOrigin).toBe('oembed');
    expect(series.metadata?.contentKind).toBe('mini-drama');
    expect(series.metadata?.currentEpisodeNumber).toBe(4);
    expect(series.episodes).toHaveLength(1);
    expect(seen.some((entry) => entry.includes('/oembed?url='))).toBe(true);
  });

  it('production repro: bot-checked short link + walled page still lists via oEmbed html', async () => {
    // What TikTok's edge actually does to a server-side tool today: 403 on the short
    // link hop and on the page, while the public oEmbed endpoint still answers and
    // names the video inside its `html` embed snippet.
    const html =
      `<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}" ` +
      `data-video-id="${DRAMA_ID}"><section></section></blockquote>`;
    const seen = stubTikTok((url) => {
      if (url.hostname === 'vt.tiktok.com') return new Response('captcha', { status: 403 });
      if (url.pathname === '/oembed') {
        return Response.json({
          title: 'Secret Wife EP 4 #minidrama #reelshort',
          author_name: 'Drama House',
          author_url: 'https://www.tiktok.com/@dramahouse',
          thumbnail_url: 'https://x.example/t.jpg',
          html,
        });
      }
      return new Response('captcha', { status: 403 });
    });
    const series = await new TikTokExtractor().extract(new URL('https://vt.tiktok.com/ZSbADyPoy/'), env());
    expect(series.episodes).toHaveLength(1);
    expect(series.episodes[0].metadata?.videoId).toBe(DRAMA_ID);
    expect(series.metadata?.contentKind).toBe('mini-drama');
    expect(series.metadata?.dataOrigin).toBe('oembed');
    expect(series.metadata?.resolvedUrl).toBe(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
    expect(seen.some((entry) => entry.includes('/oembed?url='))).toBe(true);
  });

  it('lists the video named by the link, flagged as unknown, when TikTok blocks both the page and oEmbed', async () => {
    stubTikTok(() => new Response('nope', { status: 403 }));
    const series = await new TikTokExtractor().extract(new URL(`https://www.tiktok.com/@a/video/${DRAMA_ID}`), env());
    // Blocked is not the same as missing: the id is in the link, so the video is listed...
    expect(series.episodes).toHaveLength(1);
    expect(series.episodes[0].metadata).toMatchObject({ videoId: DRAMA_ID, listOnly: true });
    expect(series.episodes[0].url).toBe(`https://www.tiktok.com/@a/video/${DRAMA_ID}`);
    // ...but nothing is guessed about it, and the result says so.
    expect(series.metadata).toMatchObject({ contentKind: 'unknown', confidence: 'low', dataOrigin: 'link', degraded: true, listComplete: false });
    expect(String(series.metadata?.listNote)).toMatch(/no public data/);
    expect(series.metadata?.diagnostics).toEqual(expect.arrayContaining([expect.stringMatching(/listing the video named by the link/)]));
  });

  it('fails with a named cause when a link names no video and TikTok returns nothing public', async () => {
    stubTikTok(() => new Response('nope', { status: 403 }));
    const error = await new TikTokExtractor()
      .extract(new URL('https://www.tiktok.com/tag/minidrama'), env())
      .catch((thrown: unknown) => thrown);
    expect((error as Error).message).toMatch(/no public data/);
    const details = (error as { details: { reason: string; diagnostics: string[] } }).details;
    expect(details.reason).toBe('no-public-data');
    expect(details.diagnostics.length).toBeGreaterThan(0);
  });

  it('asks for an episode link when given a profile', async () => {
    stubTikTok(() => undefined);
    await expect(new TikTokExtractor().extract(new URL('https://www.tiktok.com/@dramahouse'), env())).rejects.toThrow(/profile link/);
  });

  it('only handles tiktok.com, honours GRAB_ENABLED and the deny-list, and wins over the generic grabber', () => {
    const extractor = new TikTokExtractor();
    expect(extractor.canHandle(new URL('https://vm.tiktok.com/x/'), env())).toBe(true);
    expect(extractor.canHandle(new URL('https://nottiktok.com/x/'), env())).toBe(false);
    expect(extractor.canHandle(new URL('https://tiktok.com.evil.example/x/'), env())).toBe(false);
    expect(extractor.canHandle(new URL('https://www.tiktok.com/x'), env({ GRAB_DENIED_HOSTS: 'tiktok.com' }))).toBe(false);
    expect(extractor.isConfigured(env({ GRAB_ENABLED: 'false' }))).toBe(false);
    expect(resolveExtractor(new URL('https://vm.tiktok.com/ZM1/'), env()).key).toBe('tiktok');
    expect(resolveExtractor(new URL('https://video.source.dev/a'), env()).key).toBe('http-sniff');
  });
});

describe('list-only results in the API', () => {
  async function storeListing(url: string) {
    const repo = repository();
    const series = await repo.upsertSeries({
      sourceKey: 'tiktok',
      sourceUrl: url,
      canonicalUrl: `tiktok:video:${url}`,
      title: 'Listed drama',
      synopsis: null,
      posterUrl: null,
      metadata: { contentKind: 'mini-drama' },
    });
    await repo.replaceEpisodes(series.id, [1, 2].map((n) => ({
      episodeIndex: n,
      title: `Ep ${n}`,
      sourceUrl: `https://www.tiktok.com/@a/video/73000000000000000${n}0`,
      durationSeconds: null,
      thumbnailUrl: null,
      streams: [],
      metadata: { listOnly: true, episodeNumber: n },
    })));
    return series;
  }

  it('isListOnly only matches episodes without streams that the analyzer marked', () => {
    expect(isListOnly({ streams: [], metadata: {} })).toBe(false);
    expect(isListOnly({ streams: [], metadata: { listOnly: true } })).toBe(true);
    expect(isListOnly({ streams: [{ quality: '1080p', container: 'mp4' }], metadata: { listOnly: true } })).toBe(false);
  });

  it('analyze with "queue all" returns the stored list and no job instead of failing', async () => {
    const url = 'https://www.tiktok.com/@a/video/7300000000000000001';
    await storeListing(url);
    const response = await postJson('/api/analyze', { url, queueAll: true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { episodes: EpisodeRecord[]; job?: unknown; cached: boolean };
    expect(body.cached).toBe(true);
    expect(body.episodes).toHaveLength(2);
    expect(body.job).toBeUndefined();
  });

  it('refuses to queue listed-only episodes and says why', async () => {
    const series = await storeListing('https://www.tiktok.com/@a/video/7300000000000000002');
    const response = await postJson('/api/jobs', { seriesId: series.id, selection: { mode: 'all' } });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/listed for reference only/);
  });
});

// ---------------------------------------------------------------------------
// "Could not identify a video id in this link": the causes behind that message
// ---------------------------------------------------------------------------

describe('TikTok URL shapes', () => {
  it('reads playlist and collection links (the current share format is /collection/)', () => {
    expect(parseTikTokUrl(new URL('https://www.tiktok.com/@kibble/collection/Want-to-go-7665668414573546258'))).toEqual({
      username: 'kibble',
      playlistId: '7665668414573546258',
      kind: 'playlist',
    });
    expect(parseTikTokUrl(new URL('https://www.tiktok.com/@riley/playlist/Riley%20Tech%20Tips-7220878800733260549?is_from_webapp=1'))).toEqual({
      username: 'riley',
      playlistId: '7220878800733260549',
      kind: 'playlist',
    });
    // The id is the LAST number, not the first long one that happens to be in the title.
    expect(parseTikTokUrl(new URL('https://www.tiktok.com/@u/collection/Top-1234567-Picks-7665668414573546258')).playlistId).toBe(
      '7665668414573546258',
    );
    // A playlist link with no readable id is still a playlist, never "unknown".
    expect(parseTikTokUrl(new URL('https://www.tiktok.com/@u/collection/just-a-name'))).toMatchObject({ kind: 'playlist', playlistId: undefined });
  });

  it('reads locale-prefixed, legacy and username-less video links', () => {
    expect(parseTikTokUrl(new URL(`https://www.tiktok.com/en/@drama.house/video/${DRAMA_ID}`))).toMatchObject({
      username: 'drama.house',
      videoId: DRAMA_ID,
    });
    expect(parseTikTokUrl(new URL(`https://www.tiktok.com/@/video/${DRAMA_ID}`))).toEqual({ username: undefined, videoId: DRAMA_ID, kind: 'video' });
    expect(parseTikTokUrl(new URL(`https://m.tiktok.com/v/${DRAMA_ID}.html?u_code=x`))).toEqual({ videoId: DRAMA_ID, kind: 'video' });
    expect(parseTikTokUrl(new URL(`https://www.tiktok.com/share/video/${DRAMA_ID}/`))).toEqual({ videoId: DRAMA_ID, kind: 'video' });
  });

  it('does not throw on a malformed percent escape in a pasted link', () => {
    const url = new URL(`https://www.tiktok.com/@bad%E0%A4%A/video/${DRAMA_ID}`);
    expect(() => parseTikTokUrl(url)).not.toThrow();
    expect(parseTikTokUrl(url).videoId).toBe(DRAMA_ID);
  });

  it('treats /v/<number> as a long link that already names its video, not as a short code', () => {
    expect(isShortTikTokUrl(new URL(`https://www.tiktok.com/v/${DRAMA_ID}`))).toBe(false);
    expect(isShortTikTokUrl(new URL('https://www.tiktok.com/v/ZMabc123/'))).toBe(true);
    expect(isShortTikTokUrl(new URL('https://lite.tiktok.com/t/ZT1234/'))).toBe(true);
  });
});

describe('what a page does and does not say about a video', () => {
  const videoUrl = new URL(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);

  it('finds the video in JSON-escaped script strings and meta refresh redirects', () => {
    const script = `<script>window.location.replace("https:\\/\\/www.tiktok.com\\/@dramahouse\\/video\\/${DRAMA_ID}?_r=1")</script>`;
    expect(findVideoRefInHtml(script)).toMatchObject({ id: DRAMA_ID, username: 'dramahouse' });
    const unicode = `<script>var u="https:\\u002F\\u002Fwww.tiktok.com\\u002F@dramahouse\\u002Fvideo\\u002F${DRAMA_ID}"</script>`;
    expect(findVideoRefInHtml(unicode)?.id).toBe(DRAMA_ID);
    const refresh = `<meta http-equiv="refresh" content="0; url=https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}">`;
    expect(findVideoRefInHtml(refresh, { scanText: false })?.id).toBe(DRAMA_ID);
  });

  it('never adopts one video out of a page that mentions several (feed, related list, home page)', () => {
    const feed = [
      '<a href="https://www.tiktok.com/@a/video/7300000000000000001">1</a>',
      '<a href="https://www.tiktok.com/@b/video/7300000000000000002">2</a>',
    ].join('');
    expect(findVideoRefInHtml(feed)).toBeNull();
    // ...but an explicit canonical pointer still wins on the same page.
    expect(findVideoRefInHtml(`<link rel="canonical" href="https://www.tiktok.com/@b/video/7300000000000000002">${feed}`)?.id).toBe('7300000000000000002');
    // Exactly one distinct video, written twice, is unambiguous.
    const same = `<a href="https://www.tiktok.com/video/x">x</a><a href="https://www.tiktok.com/@a/video/${DRAMA_ID}">1</a><i>https://www.tiktok.com/@a/video/${DRAMA_ID}?x=1</i>`;
    expect(findVideoRefInHtml(same)?.id).toBe(DRAMA_ID);
    // A bare URL in the text is not an explicit pointer.
    expect(findVideoRefInHtml(same, { scanText: false })).toBeNull();
  });

  it('reads the wanted page out of a login redirect', () => {
    const login = new URL(`https://www.tiktok.com/login?redirect_url=${encodeURIComponent(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}?x=1`)}`);
    expect(findVideoRefInUrl(login)).toMatchObject({ id: DRAMA_ID, username: 'dramahouse' });
    expect(findVideoRefInUrl(new URL('https://www.tiktok.com/login?redirect_url=https%3A%2F%2Fevil.example%2F'))).toBeNull();
  });

  it('does not take TikTok\'s stock text for the video\'s caption', () => {
    expect(isGenericTikTokText('TikTok - Make Your Day')).toBe(true);
    expect(isGenericTikTokText('TikTok - trends start here. On a device or on the web, viewers can watch and discover millions of personalized short videos.')).toBe(true);
    expect(isGenericTikTokText('Secret Wife EP 3 #minidrama')).toBe(false);
    // On the requested URL itself, a bot-check page with generic tags yields nothing - not a fake title.
    const generic = '<title>TikTok - Make Your Day</title><meta property="og:description" content="TikTok - trends start here. On a device or on the web, viewers can watch and discover millions of personalized short videos.">';
    expect(parseVideoPage(generic, videoUrl)).toBeNull();
  });

  it('ignores the tags of a page TikTok redirected the visitor to', () => {
    const home = '<meta property="og:description" content="Watch the best clips of the day">';
    const reading = inspectVideoPage(home, new URL('https://www.tiktok.com/'), parseTikTokUrl(videoUrl));
    expect(reading.info).toBeNull();
    expect(reading.notes.join(' ')).toMatch(/do not name a video/);
  });

  it('ignores a page that is about a different video than the one requested', () => {
    const other = `<meta property="og:url" content="https://www.tiktok.com/@x/video/7999999999999999999"><meta property="og:description" content="something else">`;
    const reading = inspectVideoPage(other, new URL('https://www.tiktok.com/'), parseTikTokUrl(videoUrl));
    expect(reading.info).toBeNull();
    expect(reading.notes.join(' ')).toMatch(/different video/);
  });

  it('keeps the id and username of the request when the page JSON omits them', () => {
    const { id: _omitted, ...withoutId } = dramaItem;
    const reading = inspectVideoPage(pageHtml({ ...withoutId, author: { nickname: 'Drama House' } }), videoUrl, parseTikTokUrl(videoUrl));
    expect(reading.info?.id).toBe(DRAMA_ID);
    expect(reading.info?.username).toBe('dramahouse');
  });

  it('reports TikTok\'s own "unavailable" status instead of reading its generic tags as the video', () => {
    const data = { __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 10204, statusMsg: 'item doesn\'t exist' } } };
    const html =
      `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>` +
      '<meta property="og:description" content="Watch the best clips of the day">';
    const reading = inspectVideoPage(html, videoUrl, parseTikTokUrl(videoUrl));
    expect(reading.info).toBeNull();
    expect(reading.status).toEqual({ code: 10204, message: "item doesn't exist" });
  });

  it('lists a playlist page that enumerates its videos, and calls it a series', () => {
    const data = {
      __DEFAULT_SCOPE__: {
        'webapp.collection-detail': {
          collectionInfo: { id: '7665668414573546258', name: 'Billionaire Wife', videoCount: 2 },
          itemList: [
            { id: '7300000000000000010', desc: 'Billionaire Wife EP 1', author: { uniqueId: 'dramahouse' } },
            { id: '7300000000000000011', desc: 'Billionaire Wife EP 2', author: { uniqueId: 'dramahouse' } },
          ],
        },
      },
    };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`;
    const url = new URL('https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258');
    const info = inspectVideoPage(html, url, parseTikTokUrl(url)).info!;
    expect(info.id).toBeUndefined();
    const analysis = analyzeVideo(info, 'dramahouse');
    expect(analysis.kind).toBe('mini-drama');
    expect(analysis.episodes.map((episode) => episode.videoId)).toEqual(['7300000000000000010', '7300000000000000011']);
    expect(analysis.classification.signals.join(' ')).toMatch(/playlist \/ collection/);
  });

  it('a link-only reading is "unknown" and low confidence, never a confident "normal video"', () => {
    const info = linkOnlyInfo({ videoId: DRAMA_ID, username: 'dramahouse' });
    expect(classify(info)).toMatchObject({ kind: 'unknown', confidence: 'low' });
    const analysis = analyzeVideo(info);
    expect(analysis.kind).toBe('unknown');
    expect(analysis.episodes).toHaveLength(1);
    expect(analysis.episodes[0].url).toBe(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
    expect(analysis.listComplete).toBe(false);
    // Without any id there is nothing to list.
    expect(analyzeVideo(linkOnlyInfo({})).episodes).toEqual([]);
  });
});

describe('merging two readings of one video', () => {
  it('keeps the id from the other source when the primary has an explicit undefined id', () => {
    // The regression behind "Could not identify a video id in this link.": the page's
    // meta branch said `id: undefined`, and a spread let it erase oEmbed's id.
    const meta = { id: undefined, caption: 'hello', hashtags: ['a'], origin: 'meta' as const };
    const oembed = { id: DRAMA_ID, caption: '', username: 'dramahouse', hashtags: ['b'], origin: 'oembed' as const, cover: 'https://x.example/c.jpg' };
    expect(mergeInfo(meta, oembed)).toMatchObject({
      id: DRAMA_ID,
      caption: 'hello',
      username: 'dramahouse',
      cover: 'https://x.example/c.jpg',
      hashtags: ['a', 'b'],
      origin: 'meta',
    });
    expect(mergeInfo(null, oembed)).toBe(oembed);
    expect(mergeInfo(meta, null)).toBe(meta);
  });

  it('does not let an undefined playlist or duration erase one that is known', () => {
    const playlist = { id: '1', items: [], source: 'x' };
    const merged = mergeInfo(
      { caption: 'x', hashtags: [], origin: 'meta', playlist: undefined, durationSeconds: undefined },
      { id: DRAMA_ID, caption: '', hashtags: [], origin: 'oembed', playlist, durationSeconds: 90 },
    );
    expect(merged).toMatchObject({ playlist, durationSeconds: 90 });
  });
});

describe('short link resolution: how TikTok is asked', () => {
  const cfg = grabConfig(env());
  const noTrace = () => undefined;

  function recordFetch(handler: (url: URL, init: RequestInit | undefined, call: number) => Response) {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> | undefined });
      return handler(new URL(String(input)), init, calls.length);
    });
    return calls;
  }

  const redirectTo = (location: string, status = 302) => new Response(null, { status, headers: { location } });

  it('asks with the platform defaults first: no User-Agent of ours on the first request', async () => {
    const calls = recordFetch(() => redirectTo(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}?_r=1`));
    const resolution = await resolveShortLink(new URL('https://vt.tiktok.com/ZSbADyPoy/'), cfg, undefined, new Budget(10), noTrace);
    expect(resolution).toMatchObject({ resolved: true, notFound: false });
    expect(resolution.url.toString()).toBe(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toBeUndefined();
  });

  it('falls back to the browser-like headers when the plain request is refused, and says what happened', async () => {
    const trace: string[] = [];
    const calls = recordFetch((_url, init) =>
      init?.headers ? redirectTo(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`) : new Response('denied', { status: 403 }),
    );
    const resolution = await resolveShortLink(new URL('https://vt.tiktok.com/ZSbADyPoy/'), cfg, undefined, new Budget(10), (line) => trace.push(line));
    expect(resolution.resolved).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].headers).toBeUndefined();
    expect(calls[1].headers?.['user-agent']).toBe(cfg.userAgent);
    expect(trace.join('\n')).toMatch(/\[default headers\]: HTTP 403/);
  });

  it('never sends cookies, a crawler identity or a referer on any attempt', async () => {
    const calls = recordFetch(() => new Response('denied', { status: 403 }));
    await resolveShortLink(new URL('https://vm.tiktok.com/ZMabc123/'), cfg, undefined, new Budget(10), noTrace);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const headers = Object.fromEntries(Object.entries(call.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
      expect(headers.cookie).toBeUndefined();
      expect(headers.referer).toBeUndefined();
      expect(String(headers['user-agent'] ?? '')).not.toMatch(/facebookexternalhit|discordbot|googlebot|bingbot|twitterbot/i);
    }
  });

  it('reuses the header set that worked for the next hop of the chain', async () => {
    const calls = recordFetch((url, init) => {
      if (!init?.headers) return new Response('denied', { status: 403 });
      return url.hostname === 'vt.tiktok.com'
        ? redirectTo('https://www.tiktok.com/t/ZT999/')
        : redirectTo(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
    });
    const resolution = await resolveShortLink(new URL('https://vt.tiktok.com/ZSchain/'), cfg, undefined, new Budget(10), noTrace);
    expect(resolution.url.toString()).toBe(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
    // hop 1: plain (403) then browser (302); hop 2 goes straight to the browser set.
    expect(calls.map((call) => [new URL(call.url).host, Boolean(call.headers)])).toEqual([
      ['vt.tiktok.com', false],
      ['vt.tiktok.com', true],
      ['www.tiktok.com', true],
    ]);
  });

  it('asks /t/ links on www.tiktok.com, the only host that answers them', async () => {
    const calls = recordFetch(() => redirectTo(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`));
    await resolveShortLink(new URL('https://m.tiktok.com/t/ZT123/'), cfg, undefined, new Budget(10), noTrace);
    await resolveShortLink(new URL('https://tiktok.com/t/ZT456/'), cfg, undefined, new Budget(10), noTrace);
    expect(calls.map((call) => call.url)).toEqual(['https://www.tiktok.com/t/ZT123/', 'https://www.tiktok.com/t/ZT456/']);
  });

  it('accepts the legacy /v/<id>.html destination: the id is in the URL, nothing else is fetched', async () => {
    const calls = recordFetch(() => redirectTo(`https://m.tiktok.com/v/${DRAMA_ID}.html?u_code=abc&share_app_id=1233`));
    const resolution = await resolveShortLink(new URL('https://vm.tiktok.com/ZMlegacy/'), cfg, undefined, new Budget(10), noTrace);
    expect(calls).toHaveLength(1);
    expect(resolution.resolved).toBe(true);
    expect(parseTikTokUrl(resolution.url)).toMatchObject({ videoId: DRAMA_ID, kind: 'video' });
  });

  it('stops at any long TikTok destination instead of fetching and guessing from its page', async () => {
    const calls = recordFetch(() => redirectTo('https://www.tiktok.com/?lang=en'));
    const resolution = await resolveShortLink(new URL('https://vm.tiktok.com/ZMgone/'), cfg, undefined, new Budget(10), noTrace);
    expect(calls).toHaveLength(1);
    expect(resolution).toMatchObject({ resolved: true });
    expect(parseTikTokUrl(resolution.url).kind).toBe('unknown');
  });

  it('recovers the wanted video from a login detour and a playlist from a collection redirect', async () => {
    recordFetch(() => redirectTo(`https://www.tiktok.com/login?redirect_url=${encodeURIComponent(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`)}`));
    const viaLogin = await resolveShortLink(new URL('https://vm.tiktok.com/ZMlogin/'), cfg, undefined, new Budget(10), noTrace);
    expect(parseTikTokUrl(viaLogin.url).videoId).toBe(DRAMA_ID);

    recordFetch(() => redirectTo('https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258?_r=1'));
    const viaCollection = await resolveShortLink(new URL('https://vm.tiktok.com/ZMlist/'), cfg, undefined, new Budget(10), noTrace);
    expect(parseTikTokUrl(viaCollection.url)).toMatchObject({ kind: 'playlist', playlistId: '7665668414573546258' });
    expect(viaCollection.url.search).toBe('');
  });

  it('says "does not exist" only when every request was a 404/410, and "refused" otherwise', async () => {
    recordFetch(() => new Response('nope', { status: 404 }));
    const gone = await resolveShortLink(new URL('https://vt.tiktok.com/ZSnone/'), cfg, undefined, new Budget(10), noTrace);
    expect(gone).toMatchObject({ resolved: false, notFound: true });

    recordFetch((_url, init) => new Response('x', { status: init?.headers ? 403 : 404 }));
    const mixed = await resolveShortLink(new URL('https://vt.tiktok.com/ZSmix/'), cfg, undefined, new Budget(10), noTrace);
    expect(mixed).toMatchObject({ resolved: false, notFound: false });
  });

  it('reports a dead network as a network problem, not as TikTok refusing', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('connection reset');
    });
    await expect(resolveShortUrl(new URL('https://vt.tiktok.com/ZSdown/'), cfg, undefined, new Budget(10), noTrace)).rejects.toThrow(
      /Could not resolve the short link: connection reset/,
    );
  });

  it('keeps every hop on TikTok and inside the SSRF guard', async () => {
    recordFetch(() => redirectTo('https://tiktok.com.evil.example/steal'));
    await expect(resolveShortUrl(new URL('https://vt.tiktok.com/ZSevil/'), cfg, undefined, new Budget(10), noTrace)).rejects.toThrow(/not TikTok/);
    recordFetch(() => redirectTo('https://localhost/x'));
    await expect(resolveShortUrl(new URL('https://vt.tiktok.com/ZSlocal/'), cfg, undefined, new Budget(10), noTrace)).rejects.toThrow();
  });

  it('is bounded: a loop of short links ends in an error, not an endless crawl', async () => {
    const calls = recordFetch(() => redirectTo('https://www.tiktok.com/t/ZTloop/'));
    await expect(resolveShortUrl(new URL('https://vt.tiktok.com/ZSloop/'), cfg, undefined, new Budget(50), noTrace)).rejects.toThrow(/Too many redirects/);
    expect(calls.length).toBeLessThanOrEqual(cfg.maxRedirects + 1);
  });
});

describe('TikTokExtractor: the ways a link used to end in "Could not identify a video id"', () => {
  type Handler = (url: URL, init: RequestInit | undefined) => Response | undefined;

  function stub(handler: Handler) {
    const calls: Array<{ url: URL; headers: unknown }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, headers: init?.headers });
      return handler(url, init) ?? new Response('not found', { status: 404 });
    });
    return calls;
  }

  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
  const oembedFor = (extra: Record<string, unknown> = {}) =>
    Response.json({
      title: 'Secret Wife EP 4 #minidrama #reelshort',
      author_name: 'Drama House',
      author_url: 'https://www.tiktok.com/@dramahouse',
      thumbnail_url: 'https://x.example/t.jpg',
      embed_product_id: DRAMA_ID,
      ...extra,
    });
  const failureOf = async (url: string) => {
    const error = await new TikTokExtractor().extract(new URL(url), env()).catch((thrown: unknown) => thrown);
    return error as Error & { details: { reason: string; diagnostics: string[]; resolvedUrl?: string } };
  };

  it('REGRESSION: a page TikTok redirected away no longer wipes the video id that oEmbed knows', async () => {
    // Real chain behind the report: the video URL answers with a redirect to a landing
    // page whose tags carry a caption but name no video; oEmbed works. The old merge
    // let the landing page's `id: undefined` win and ended in "Could not identify a video id".
    const calls = stub((url) => {
      if (url.pathname === '/oembed') return oembedFor();
      if (url.pathname.includes('/video/')) return new Response(null, { status: 302, headers: { location: 'https://www.tiktok.com/explore' } });
      if (url.pathname === '/explore') return html('<meta property="og:description" content="Discover the best clips">');
      return undefined;
    });
    const series = await new TikTokExtractor().extract(new URL(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`), env());
    expect(series.episodes).toHaveLength(1);
    expect(series.episodes[0].metadata?.videoId).toBe(DRAMA_ID);
    expect(series.metadata).toMatchObject({ dataOrigin: 'oembed', contentKind: 'mini-drama', currentEpisodeNumber: 4 });
    expect(series.metadata?.diagnostics).toEqual(expect.arrayContaining([expect.stringMatching(/not the requested/), expect.stringMatching(/do not name a video/)]));
    expect(calls.some((call) => call.url.pathname === '/oembed')).toBe(true);
  });

  it('lists the video the link names even when oEmbed carries no id of its own', async () => {
    stub((url) => {
      if (url.pathname === '/oembed') return oembedFor({ embed_product_id: undefined });
      return new Response(null, { status: 302, headers: { location: 'https://www.tiktok.com/explore' } });
    });
    const series = await new TikTokExtractor().extract(new URL(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`), env());
    expect(series.episodes[0].metadata?.videoId).toBe(DRAMA_ID);
  });

  it('asks oEmbed about the canonical long URL, never about the short link or a legacy form', async () => {
    const calls = stub((url) => {
      if (url.hostname === 'vm.tiktok.com') return new Response(null, { status: 302, headers: { location: `https://m.tiktok.com/v/${DRAMA_ID}.html?u_code=1` } });
      if (url.pathname === '/oembed') return oembedFor();
      return new Response('captcha', { status: 403 });
    });
    const series = await new TikTokExtractor().extract(new URL('https://vm.tiktok.com/ZMlegacy/'), env());
    expect(series.episodes[0].metadata?.videoId).toBe(DRAMA_ID);
    const asked = calls.map((call) => call.url.toString());
    // The page is requested at the standard spelling (username unknown = "@_"), and so is oEmbed.
    expect(asked).toContain(`https://www.tiktok.com/@_/video/${DRAMA_ID}`);
    const oembed = asked.find((entry) => entry.includes('/oembed?url='))!;
    expect(new URL(oembed).searchParams.get('url')).toBe(`https://www.tiktok.com/@_/video/${DRAMA_ID}`);
  });

  it('resolves a short link that only answers a plain request (browser headers are refused)', async () => {
    stub((url, init) => {
      if (url.hostname === 'vt.tiktok.com') {
        return init?.headers
          ? new Response('captcha', { status: 403 })
          : new Response(null, { status: 302, headers: { location: `https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}?_r=1` } });
      }
      if (url.pathname.includes('/video/')) return html(pageHtml(dramaItem, dramaScope));
      return undefined;
    });
    const series = await new TikTokExtractor().extract(new URL('https://vt.tiktok.com/ZSbADyPoy/'), env());
    expect(series.title).toBe("The Billionaire's Secret Wife");
    expect(series.metadata).toMatchObject({ resolvedUrl: `https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`, dataOrigin: 'page-json' });
    expect(series.metadata).not.toHaveProperty('degraded');
  });

  it('lists the bare short link, flagged and explained, when TikTok refuses every way of opening it', async () => {
    stub(() => new Response('captcha', { status: 403 }));
    const series = await new TikTokExtractor().extract(new URL('https://vt.tiktok.com/ZSbADyPoy/?_r=1&u_code=abc'), env());
    expect(series.canonicalUrl).toBe('tiktok:short:ZSbADyPoy');
    expect(series.sourceUrl).toBe('https://vt.tiktok.com/ZSbADyPoy/?_r=1&u_code=abc');
    expect(series.episodes).toHaveLength(1);
    // The episode URL is the short link without tracking: the SSSTik provider resolves it itself.
    expect(series.episodes[0].url).toBe('https://vt.tiktok.com/ZSbADyPoy/');
    expect(series.episodes[0].streams).toEqual([]);
    expect(series.episodes[0].metadata).toMatchObject({ platform: 'tiktok', listOnly: true, unresolvedShortLink: true });
    expect(series.metadata).toMatchObject({ contentKind: 'unknown', confidence: 'low', degraded: true, dataOrigin: 'link' });
    expect(String(series.metadata?.listNote)).toMatch(/short link/);
    expect(String(series.metadata?.listNote)).toMatch(/long address/);
    expect((series.metadata?.diagnostics as string[]).join('\n')).toMatch(/HTTP 403/);
  });

  it('answers a short link TikTok says does not exist with that fact, not a generic failure', async () => {
    stub(() => new Response('nope', { status: 404 }));
    const error = await failureOf('https://vt.tiktok.com/ZSnone/');
    expect(error.message).toMatch(/does not exist/);
    expect(error.details.reason).toBe('short-link-not-found');
  });

  it('turns a playlist / collection link into an explanation and a next step, not "could not identify"', async () => {
    stub(() => html('<html><title>TikTok</title></html>'));
    for (const link of [
      'https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258',
      'https://www.tiktok.com/@dramahouse/playlist/Billionaire%20Wife-7665668414573546258',
    ]) {
      const error = await failureOf(link);
      expect(error.details.reason).toBe('playlist-link');
      expect(error.message).toMatch(/playlist \/ collection/);
      expect(error.message).toMatch(/tap any one episode/);
      expect(error.message).not.toMatch(/Could not identify/);
    }
  });

  it('does not ask oEmbed about a playlist (it only understands videos)', async () => {
    const calls = stub(() => html('<html></html>'));
    await failureOf('https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258');
    expect(calls.some((call) => call.url.pathname === '/oembed')).toBe(false);
  });

  it('lists every episode of a collection when its public page really enumerates them', async () => {
    const data = {
      __DEFAULT_SCOPE__: {
        'webapp.collection-detail': {
          collectionInfo: { id: '7665668414573546258', name: 'Billionaire Wife', videoCount: 2 },
          itemList: [
            { id: '7300000000000000010', desc: 'Billionaire Wife EP 1', author: { uniqueId: 'dramahouse' } },
            { id: '7300000000000000011', desc: 'Billionaire Wife EP 2', author: { uniqueId: 'dramahouse' } },
          ],
        },
      },
    };
    stub(() => html(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`));
    const series = await new TikTokExtractor().extract(
      new URL('https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258'),
      env(),
    );
    expect(series.episodes.map((episode) => episode.metadata?.videoId)).toEqual(['7300000000000000010', '7300000000000000011']);
    expect(series.metadata).toMatchObject({ contentKind: 'mini-drama' });
    expect(series.canonicalUrl).toBe('tiktok:playlist:7665668414573546258');
  });

  it('follows a short link that points at a playlist to the same explanation', async () => {
    stub((url) => {
      if (url.hostname === 'vt.tiktok.com') {
        return new Response(null, { status: 302, headers: { location: 'https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258?_r=1' } });
      }
      return html('<html></html>');
    });
    const error = await failureOf('https://vt.tiktok.com/ZSlist/');
    expect(error.details.reason).toBe('playlist-link');
    expect(error.details.resolvedUrl).toBe('https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258');
  });

  it('says a video is unavailable when TikTok\'s own page says so, instead of listing a guess', async () => {
    const data = { __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 10204, statusMsg: "item doesn't exist" } } };
    stub((url) =>
      url.pathname === '/oembed'
        ? new Response('bad request', { status: 400 })
        : html(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`),
    );
    const error = await failureOf(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`);
    expect(error.details.reason).toBe('unavailable');
    expect(error.message).toMatch(/code 10204/);
    expect(error.message).toMatch(/private, removed/);
  });

  it('still lists a video TikTok calls unavailable when oEmbed can name it', async () => {
    const data = { __DEFAULT_SCOPE__: { 'webapp.video-detail': { statusCode: 10204 } } };
    stub((url) =>
      url.pathname === '/oembed'
        ? oembedFor()
        : html(`<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script>`),
    );
    const series = await new TikTokExtractor().extract(new URL(`https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}`), env());
    expect(series.metadata).toMatchObject({ dataOrigin: 'oembed' });
  });

  it('names the page a short link ended on when that is not a video, with the steps in the diagnostics', async () => {
    stub((url) => {
      if (url.hostname === 'vm.tiktok.com') return new Response(null, { status: 302, headers: { location: 'https://www.tiktok.com/tag/minidrama' } });
      return new Response('nope', { status: 403 });
    });
    const error = await failureOf('https://vm.tiktok.com/ZMtag/');
    expect(error.details.reason).toBe('no-public-data');
    expect(error.message).toMatch(/ended on www\.tiktok\.com\/tag\/minidrama/);
    expect(error.details.diagnostics.join('\n')).toMatch(/short link hop 1/);
  });

  it('never lists a random video out of a generic page just because it is the first one mentioned', async () => {
    const feed =
      '<meta property="og:description" content="Discover the best clips">' +
      '<a href="https://www.tiktok.com/@a/video/7300000000000000001">1</a><a href="https://www.tiktok.com/@b/video/7300000000000000002">2</a>';
    stub((url) => (url.hostname === 'vm.tiktok.com' ? new Response(null, { status: 302, headers: { location: 'https://www.tiktok.com/explore' } }) : html(feed)));
    const error = await failureOf('https://vm.tiktok.com/ZMfeed/');
    expect(error.details.reason).toBe('no-public-data');
  });
});

describe('degraded listings and the analyze cache', () => {
  const url = 'https://vt.tiktok.com/ZSdegraded/';

  // The test deployment (wrangler.test.jsonc) turns the real grabber off, so the route is
  // driven with the grabber on - the way production runs it.
  const analyzeVia = (body: unknown): Promise<Response> =>
    Promise.resolve(
      app.fetch(
        new Request('https://vtgrab.test/api/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        env(),
      ),
    );

  async function storeDegraded() {
    const repo = repository();
    const series = await repo.upsertSeries({
      sourceKey: 'tiktok',
      sourceUrl: url,
      canonicalUrl: 'tiktok:short:ZSdegraded',
      title: 'TikTok short link ZSdegraded',
      synopsis: null,
      posterUrl: null,
      metadata: { contentKind: 'unknown', degraded: true },
    });
    await repo.replaceEpisodes(series.id, [
      { episodeIndex: 1, title: 'old', sourceUrl: url, durationSeconds: null, thumbnailUrl: null, streams: [], metadata: { listOnly: true, platform: 'tiktok' } },
    ]);
    return series;
  }

  it('re-runs the analyzer instead of replaying an old "nothing could be read" answer', async () => {
    await storeDegraded();
    // TikTok answers properly this time.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const target = new URL(String(input));
      if (target.hostname === 'vt.tiktok.com') {
        return new Response(null, { status: 302, headers: { location: `https://www.tiktok.com/@dramahouse/video/${DRAMA_ID}?_r=1` } });
      }
      return new Response(pageHtml(dramaItem, dramaScope), { headers: { 'content-type': 'text/html' } });
    });
    const response = await analyzeVia({ url });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cached: boolean; series: { title: string; metadata: Record<string, unknown> }; episodes: EpisodeRecord[] };
    expect(body.cached).toBe(false);
    expect(body.series.title).toBe("The Billionaire's Secret Wife");
    expect(body.series.metadata.degraded).toBeUndefined();
    expect(body.episodes.length).toBeGreaterThan(0);
  });

  it('still answers from the cache for an ordinary (non-degraded) TikTok listing', async () => {
    const repo = repository();
    const cachedUrl = 'https://vt.tiktok.com/ZScached/';
    const series = await repo.upsertSeries({
      sourceKey: 'tiktok',
      sourceUrl: cachedUrl,
      canonicalUrl: 'tiktok:video:7300000000000000099',
      title: 'Cached drama',
      synopsis: null,
      posterUrl: null,
      metadata: { contentKind: 'mini-drama' },
    });
    await repo.replaceEpisodes(series.id, [
      { episodeIndex: 1, title: 'Ep 1', sourceUrl: 'https://www.tiktok.com/@a/video/7300000000000000099', durationSeconds: null, thumbnailUrl: null, streams: [], metadata: { listOnly: true } },
    ]);
    const fetchSpy = vi.fn(async () => new Response('should not be called', { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);
    const response = await analyzeVia({ url: cachedUrl });
    const body = (await response.json()) as { cached: boolean; series: { title: string } };
    expect(body.cached).toBe(true);
    expect(body.series.title).toBe('Cached drama');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a failure through the API with its reason and diagnostics, and never caches it', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }));
    const target = 'https://www.tiktok.com/@dramahouse/collection/Billionaire-Wife-7665668414573546258';
    const response = await analyzeVia({ url: target });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string; details: { reason: string; diagnostics: string[] } } };
    expect(body.error.details.reason).toBe('playlist-link');
    expect(body.error.details.diagnostics.length).toBeGreaterThan(0);
    expect(await repository().getSeriesBySourceUrl(target)).toBeNull();
  });
});
