import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { grabConfig } from '../src/grab/config';
import { Budget } from '../src/grab/net';
import {
  analyzeVideo,
  canonicalVideoUrl,
  classify,
  cleanTitle,
  isShortTikTokUrl,
  normalizeDigits,
  parseEpisodeMarker,
  parseOEmbed,
  parseTikTokUrl,
  parseVideoPage,
} from '../src/grab/tiktok';
import { resolveExtractor } from '../src/providers/extract/registry';
import { resolveShortUrl, TikTokExtractor } from '../src/providers/extract/tiktok';
import { isListOnly } from '../src/jobs/service';
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

  it('fails with an honest message when TikTok returns nothing public', async () => {
    stubTikTok(() => new Response('nope', { status: 403 }));
    const error = await new TikTokExtractor()
      .extract(new URL(`https://www.tiktok.com/@a/video/${DRAMA_ID}`), env())
      .catch((thrown: unknown) => thrown);
    expect((error as Error).message).toMatch(/no public data/);
    expect((error as { details: { diagnostics: string[] } }).details.diagnostics.length).toBeGreaterThan(0);
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
