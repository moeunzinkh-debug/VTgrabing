import { describe, expect, it } from 'vitest';
import { repository, requestJson, postJson } from './helpers';
import type { EpisodeRecord, SeriesRecord } from '../src/shared/types';

interface AnalyzeResponse {
  series: SeriesRecord;
  episodes: EpisodeRecord[];
  extractor: string;
  cached: boolean;
}

describe('POST /api/analyze', () => {
  it('extracts a series with the MockExtractor and persists it in D1', async () => {
    const result = await postJson('/api/analyze', { url: 'https://mock.local/series/alpha' });
    expect(result.status).toBe(200);

    const body = (await result.json()) as AnalyzeResponse;
    expect(body.cached).toBe(false);
    expect(body.extractor).toBe('mock');
    expect(body.series.id).toMatch(/^ser_/);
    expect(body.episodes.length).toBeGreaterThanOrEqual(6);

    // Episode indexes are 1..N with no gaps.
    expect(body.episodes.map((episode) => episode.episodeIndex)).toEqual(
      body.episodes.map((_episode, index) => index + 1),
    );

    // The rows really exist in D1 (not just in the response).
    const repo = repository();
    const stored = await repo.getSeries(body.series.id);
    expect(stored?.title).toBe(body.series.title);
    expect(stored?.episodeCount).toBe(body.episodes.length);

    const episodes = await repo.listEpisodes(body.series.id);
    expect(episodes).toHaveLength(body.episodes.length);
    expect(episodes[0].streams.length).toBeGreaterThan(0);
    expect(episodes[0].streams[0].quality).toBe('1080p');
  });

  it('serves the cached series on a second call and re-extracts with refresh', async () => {
    const url = 'https://mock.local/series/cache-me';
    const first = (await (await postJson('/api/analyze', { url })).json()) as AnalyzeResponse;
    const cached = (await (await postJson('/api/analyze', { url })).json()) as AnalyzeResponse;
    expect(cached.cached).toBe(true);
    expect(cached.series.id).toBe(first.series.id);
    expect(cached.episodes).toHaveLength(first.episodes.length);

    const refreshed = (await (
      await postJson('/api/analyze', { url, refresh: true })
    ).json()) as AnalyzeResponse;
    expect(refreshed.cached).toBe(false);
    expect(refreshed.series.id).toBe(first.series.id);
  });

  it('rejects invalid input', async () => {
    const bad = await postJson('/api/analyze', { url: 'not-a-url' });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: { code: string; details: unknown[] } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.length).toBeGreaterThan(0);

    const missing = await postJson('/api/analyze', {});
    expect(missing.status).toBe(400);
  });

  it('rejects unknown source keys', async () => {
    const response = await postJson('/api/analyze', {
      url: 'https://mock.local/series/x',
      sourceKey: 'does-not-exist',
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_source');
  });

  it('refuses an unauthorized extractor that is not configured', async () => {
    // The test deployment has no SOURCE_API_BASE_URL, so the authorized extractor
    // must report itself unavailable instead of pretending to work.
    const sources = await requestJson<{
      extractors: Array<{ key: string; configured: boolean; available: boolean }>;
    }>('/api/sources');
    const authorized = sources.extractors.find((item) => item.key === 'authorized-http');
    expect(authorized?.configured).toBe(false);
    expect(authorized?.available).toBe(false);

    const response = await postJson('/api/analyze', {
      url: 'https://not-allowed.example/series/1',
      sourceKey: 'authorized-http',
    });
    expect(response.status).toBe(422);
  });
});

describe('GET /api/series', () => {
  it('lists and reads back a stored series', async () => {
    const analyzed = (await (
      await postJson('/api/analyze', { url: 'https://mock.local/series/listing' })
    ).json()) as AnalyzeResponse;

    const list = await requestJson<{ items: SeriesRecord[]; total: number }>('/api/series?limit=10');
    expect(list.total).toBeGreaterThan(0);
    expect(list.items.map((item) => item.id)).toContain(analyzed.series.id);

    const detail = await requestJson<{ series: SeriesRecord; episodes: EpisodeRecord[] }>(
      `/api/series/${analyzed.series.id}`,
    );
    expect(detail.series.id).toBe(analyzed.series.id);
    expect(detail.episodes).toHaveLength(analyzed.episodes.length);
  });

  it('returns 404 for an unknown series', async () => {
    const response = await requestJson<{ error: { code: string } }>('/api/series/ser_missing');
    expect(response.error.code).toBe('not_found');
  });
});

describe('GET /api/health', () => {
  it('reports the D1 binding as reachable', async () => {
    const health = await requestJson<{
      ok: boolean;
      bindings: { database: boolean; bucket: boolean; queue: boolean };
    }>('/api/health');
    expect(health.ok).toBe(true);
    expect(health.bindings).toEqual({ database: true, bucket: true, queue: true });
  });
});
