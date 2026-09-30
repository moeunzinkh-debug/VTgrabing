import { describe, expect, it } from 'vitest';
import { analyze, postJson, repository, requestJson, seedJob, testEnv, waitFor } from './helpers';
import type { Env } from '../src/env';
import type { EpisodeRecord, FileRecord, JobDetail, JobItemView, SeriesRecord } from '../src/shared/types';

interface AnalyzeResponse {
  series: SeriesRecord;
  episodes: EpisodeRecord[];
}

async function getJob(jobId: string): Promise<JobDetail> {
  return requestJson<JobDetail>(`/api/jobs/${jobId}`);
}

async function waitForJob(
  jobId: string,
  statuses: string[],
  timeoutMs = 30_000,
): Promise<JobDetail> {
  let last: JobDetail | null = null;
  await waitFor(
    `job ${jobId} to reach ${statuses.join('/')}`,
    async () => {
      last = await getJob(jobId);
      return statuses.includes(last.job.status);
    },
    timeoutMs,
  );
  return last!;
}

describe('POST /api/jobs (selected episodes)', () => {
  it('creates a job with one queue-backed item per selected episode', async () => {
    const body = (await (
      await postJson('/api/analyze', { url: 'https://mock.local/series/selected' })
    ).json()) as AnalyzeResponse;
    const picked = [body.episodes[1], body.episodes[3]];

    const response = await postJson('/api/jobs', {
      seriesId: body.series.id,
      selection: { mode: 'ids', episodeIds: picked.map((episode) => episode.id) },
      options: { quality: '720p', container: 'mp4', concurrency: 2, prefix: 'jobs-test' },
    });
    expect(response.status).toBe(201);

    const created = (await response.json()) as JobDetail;
    expect(created.job.status).toBe('pending');
    expect(created.job.totalItems).toBe(2);
    expect(created.items).toHaveLength(2);
    expect(created.items.map((item) => item.episodeId)).toEqual(picked.map((episode) => episode.id));
    expect(created.items.every((item) => item.status === 'pending')).toBe(true);
    expect(created.items[0].objectKey).toMatch(/^jobs-test\//);

    // D1 really holds the rows.
    const repo = repository();
    const items = await repo.listJobItems(created.job.id);
    expect(items).toHaveLength(2);
    const rawItems = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS total FROM job_items WHERE job_id = ?`,
    )
      .bind(created.job.id)
      .first<{ total: number }>();
    expect(rawItems?.total).toBe(2);

    // The queue consumer picks the items up and completes them.
    const finished = await waitForJob(created.job.id, ['completed', 'partial', 'failed']);
    expect(finished.job.status).toBe('completed');
    expect(finished.job.completedItems).toBe(2);
    expect(finished.job.failedItems).toBe(0);
    expect(finished.items.every((item) => item.status === 'completed')).toBe(true);
    expect(finished.items.every((item) => item.bytes > 0)).toBe(true);

    // Objects are in R2 and rows are in the files table.
    for (const item of finished.items) {
      const object = await testEnv.FILES.head(item.objectKey);
      expect(object).not.toBeNull();
      expect(object?.size).toBe(item.bytes);
    }
    const files = await requestJson<{ items: FileRecord[] }>(`/api/files?jobId=${created.job.id}`);
    expect(files.items).toHaveLength(2);
    expect(files.items[0].provider).toBe('mock');
    expect(files.items[0].quality).toBe('720p');
  });

  it('supports range selection', async () => {
    const body = (await (
      await postJson('/api/analyze', { url: 'https://mock.local/series/range' })
    ).json()) as AnalyzeResponse;

    const response = await postJson('/api/jobs', {
      seriesId: body.series.id,
      selection: { mode: 'range', from: 2, to: 4 },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as JobDetail;
    expect(created.items.map((item) => item.episodeIndex)).toEqual([2, 3, 4]);

    const finished = await waitForJob(created.job.id, ['completed', 'partial', 'failed']);
    expect(finished.job.completedItems).toBe(3);
  });

  it('supports download-all selection', async () => {
    const body = (await (
      await postJson('/api/analyze', { url: 'https://mock.local/series/all' })
    ).json()) as AnalyzeResponse;

    const response = await postJson('/api/jobs', {
      seriesId: body.series.id,
      selection: { mode: 'all' },
      options: { concurrency: 4 },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as JobDetail;
    expect(created.items).toHaveLength(body.episodes.length);

    const finished = await waitForJob(created.job.id, ['completed', 'partial', 'failed']);
    expect(finished.job.status).toBe('completed');
    expect(finished.job.completedItems).toBe(body.episodes.length);
    expect(finished.job.finishedAt).not.toBeNull();
  });

  it('rejects invalid payloads', async () => {
    const body = (await (
      await postJson('/api/analyze', { url: 'https://mock.local/series/invalid' })
    ).json()) as AnalyzeResponse;

    const empty = await postJson('/api/jobs', {
      seriesId: body.series.id,
      selection: { mode: 'ids', episodeIds: [] },
    });
    expect(empty.status).toBe(400);

    const unknownSeries = await postJson('/api/jobs', {
      seriesId: 'ser_nope',
      selection: { mode: 'all' },
    });
    expect(unknownSeries.status).toBe(404);

    const unknownProvider = await postJson('/api/jobs', {
      seriesId: body.series.id,
      selection: { mode: 'all' },
      options: { provider: 'nope' },
    });
    expect(unknownProvider.status).toBe(422);

    const notConfiguredProvider = await postJson('/api/jobs', {
      seriesId: body.series.id,
      selection: { mode: 'all' },
      options: { provider: 'remote' },
    });
    expect(notConfiguredProvider.status).toBe(503);

    const unresolved = await postJson('/api/jobs', {
      seriesId: body.series.id,
      selection: { mode: 'ids', episodeIds: ['ep_does_not_exist'] },
    });
    expect(unresolved.status).toBe(400);
  });
});

describe('job lifecycle (cancel / retry)', () => {
  it('cancels pending items and re-queues them on retry', async () => {
    const seeded = await seedJob(3, 2);

    const beforeCancel = await getJob(seeded.jobId);
    expect(beforeCancel.job.status).toBe('pending');
    expect(beforeCancel.items.every((item: JobItemView) => item.status === 'pending')).toBe(true);

    const cancelResponse = await postJson(`/api/jobs/${seeded.jobId}/cancel`, {});
    expect(cancelResponse.status).toBe(200);
    const cancelled = (await cancelResponse.json()) as JobDetail;
    expect(cancelled.job.status).toBe('cancelled');
    expect(cancelled.items.every((item) => item.status === 'cancelled')).toBe(true);

    const retryResponse = await postJson(`/api/jobs/${seeded.jobId}/retry`, {});
    expect(retryResponse.status).toBe(200);
    const retried = (await retryResponse.json()) as JobDetail;
    expect(retried.job.status).toBe('pending');
    expect(retried.items.every((item) => item.status === 'pending')).toBe(true);

    // The retry really published queue messages: the consumer finishes the job.
    const finished = await waitForJob(seeded.jobId, ['completed', 'partial', 'failed']);
    expect(finished.job.status).toBe('completed');
    expect(finished.job.completedItems).toBe(3);

    for (const key of seeded.objectKeys) {
      const object = await testEnv.FILES.head(key);
      expect(object).not.toBeNull();
      expect(object!.size).toBeGreaterThan(0);
    }
  });

  it('records progress events in D1', async () => {
    const seeded = await seedJob(1, 1, 'failed');
    await postJson(`/api/jobs/${seeded.jobId}/retry`, {});
    await waitForJob(seeded.jobId, ['completed', 'partial', 'failed']);

    const events = await requestJson<{ events: Array<{ message: string; level: string }> }>(
      `/api/jobs/${seeded.jobId}/events?limit=50`,
    );
    expect(events.events.length).toBeGreaterThan(0);
    const messages = events.events.map((event) => event.message).join('\n');
    expect(messages).toContain('Downloading episode');
    expect(messages).toContain('Stored');
    expect(messages).toContain('Job closed as completed');
  });

  it('rejects cancelling an already finished job', async () => {
    const seeded = await seedJob(1, 1, 'failed');
    await postJson(`/api/jobs/${seeded.jobId}/retry`, {});
    await waitForJob(seeded.jobId, ['completed']);

    const response = await postJson(`/api/jobs/${seeded.jobId}/cancel`, {});
    expect(response.status).toBe(409);
  });
});

describe('GET /api/jobs', () => {
  it('lists jobs with their counters', async () => {
    const body = (await (
      await postJson('/api/analyze', { url: 'https://mock.local/series/list-jobs' })
    ).json()) as AnalyzeResponse;
    const created = (await (
      await postJson('/api/jobs', {
        seriesId: body.series.id,
        selection: { mode: 'ids', episodeIds: [body.episodes[0].id] },
      })
    ).json()) as JobDetail;
    await waitForJob(created.job.id, ['completed', 'partial', 'failed']);

    const list = await requestJson<{
      items: Array<{ id: string; status: string; seriesTitle: string | null }>;
      total: number;
    }>('/api/jobs?limit=20');
    const found = list.items.find((item) => item.id === created.job.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe('completed');
    expect(found?.seriesTitle).toBe(body.series.title);

    const filtered = await requestJson<{ items: Array<{ id: string }> }>('/api/jobs?status=cancelled');
    expect(filtered.items.some((item) => item.id === created.job.id)).toBe(false);
  });

  it('returns the configured provider status on /api/sources', async () => {
    const sources = await requestJson<{
      downloadProviders: Array<{ key: string; kind: string; available: boolean }>;
      limits: { maxAttempts: number; defaultConcurrency: number };
    }>('/api/sources');
    expect(sources.downloadProviders.map((item) => item.key)).toEqual(['remote', 'mock']);
    expect(sources.downloadProviders.find((item) => item.key === 'mock')?.available).toBe(true);
    expect(sources.downloadProviders.find((item) => item.key === 'remote')?.available).toBe(false);
    expect(sources.limits.maxAttempts).toBe(3);
  });
});

describe('mock provider honesty', () => {
  it('writes clearly labelled synthetic objects, never real media', async () => {
    const seeded = await seedJob(1, 1, 'failed');
    await postJson(`/api/jobs/${seeded.jobId}/retry`, {});
    await waitForJob(seeded.jobId, ['completed']);

    const object = await testEnv.FILES.get(seeded.objectKeys[0]);
    expect(object).not.toBeNull();
    const text = await object!.text();
    expect(text.startsWith('VTGrab MOCK OBJECT - NOT REAL MEDIA')).toBe(true);
  });

  it('marks mock object keys with a .mock suffix', async () => {
    const body = (await (
      await postJson('/api/analyze', { url: 'https://mock.local/series/suffix' })
    ).json()) as AnalyzeResponse;
    const created = (await (
      await postJson('/api/jobs', {
        seriesId: body.series.id,
        selection: { mode: 'ids', episodeIds: [body.episodes[0].id] },
      })
    ).json()) as JobDetail;
    expect(created.items[0].objectKey).toMatch(/S01E01-.*\.mock\.mp4$/);
    await waitForJob(created.job.id, ['completed']);
  });
});

describe('environment helpers', () => {
  it('keeps mocks enabled only for non-production environments', async () => {
    const env = testEnv;
    expect(env.MOCK_ENABLED).toBe('true');
    const production = { ...env, ENVIRONMENT: 'production', MOCK_ENABLED: 'false' } as Env;
    const { mocksEnabled } = await import('../src/env');
    expect(mocksEnabled(env)).toBe(true);
    expect(mocksEnabled(production)).toBe(false);
  });
});

describe('repository counters', () => {
  it('recomputes job counters directly from job_items', async () => {
    const { series, episodes } = await analyze('https://mock.local/series/counters');
    const repo = repository();
    const job = await repo.createJob({
      seriesId: series.id,
      selection: { mode: 'ids', episodeIds: episodes.slice(0, 2).map((episode) => episode.id) },
      options: { quality: '1080p', container: 'mp4', concurrency: 1, prefix: 'counters' },
      items: episodes.slice(0, 2).map((episode, index) => ({
        episodeId: episode.id,
        seriesId: series.id,
        position: index + 1,
        quality: '1080p',
        container: 'mp4',
        objectKey: `counters/ep-${index + 1}.mp4`,
      })),
    });

    const items = await repo.listJobItems(job.id);
    await repo.updateJobItem(items[0].id, { status: 'completed', bytes: 1234, progress: 100 });
    await repo.updateJobItem(items[1].id, { status: 'failed', error: 'boom' });

    const recomputed = await repo.recomputeJob(job.id);
    expect(recomputed.totalItems).toBe(2);
    expect(recomputed.completedItems).toBe(1);
    expect(recomputed.failedItems).toBe(1);
    expect(recomputed.status).toBe('partial');
    expect(recomputed.finishedAt).not.toBeNull();
  });
});
