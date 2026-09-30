import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import type { EpisodeRecord, FileRecord, JobDetail, SeriesRecord } from '../src/shared/types';
import { waitFor } from './helpers';

function zeroBindingEnv(): Env {
  return {
    ENVIRONMENT: 'production',
    MOCK_ENABLED: 'true',
    MAX_ATTEMPTS: '3',
    DEFAULT_QUALITY: '1080p',
    DEFAULT_CONTAINER: 'mp4',
    DEFAULT_CONCURRENCY: '4',
    FILE_URL_TTL_SECONDS: '3600',
    QUEUE_PUSH_BATCH_SIZE: '100',
    STALE_ITEM_MINUTES: '20',
    SOURCE_ALLOWED_HOSTS: '',
    PUBLIC_BASE_URL: '',
  } as unknown as Env;
}

function makeCtx(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

async function callWorker(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; pending: Promise<unknown>[] }> {
  const { ctx, pending } = makeCtx();
  const request = new Request(`https://vtgrabing.workers.dev${path}`, init);
  const response = await worker.fetch!(request as never, env, ctx);
  return { response, pending };
}

describe('Zero-binding Cloudflare deployment (built-in Edge fallbacks)', () => {
  it('runs the full analyze -> job -> queue -> R2 download flow without pre-created bindings', async () => {
    const env = zeroBindingEnv();

    // 1. Health check reports all bindings ready and auto-infers PUBLIC_BASE_URL
    const { response: healthRes } = await callWorker(env, '/api/health');
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      bindings: { database: boolean; bucket: boolean; queue: boolean };
    };
    expect(health.ok).toBe(true);
    expect(health.bindings).toEqual({ database: true, bucket: true, queue: true });
    expect(env.PUBLIC_BASE_URL).toBe('https://vtgrabing.workers.dev');

    // 2. Analyze a series
    const { response: analyzeRes } = await callWorker(env, '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://mock.local/series/cloudflare-zero-config' }),
    });
    expect(analyzeRes.status).toBe(200);
    const analyzed = (await analyzeRes.json()) as {
      series: SeriesRecord;
      episodes: EpisodeRecord[];
      cached: boolean;
    };
    expect(analyzed.cached).toBe(false);
    expect(analyzed.episodes.length).toBeGreaterThanOrEqual(6);

    // 3. Create a download job for 2 episodes
    const picked = analyzed.episodes.slice(0, 2).map((ep) => ep.id);
    const { response: jobRes, pending } = await callWorker(env, '/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seriesId: analyzed.series.id,
        selection: { mode: 'ids', episodeIds: picked },
        options: { quality: '1080p', container: 'mp4', concurrency: 2, prefix: 'cf-deploy' },
      }),
    });
    expect(jobRes.status).toBe(201);
    const created = (await jobRes.json()) as JobDetail;
    expect(created.job.totalItems).toBe(2);

    // Wait for background queue drain registered via ctx.waitUntil
    await Promise.all(pending);
    await waitFor('fallback queue job completion', async () => {
      const { response } = await callWorker(env, `/api/jobs/${created.job.id}`);
      const detail = (await response.json()) as JobDetail;
      return detail.job.status === 'completed';
    });

    // 4. Verify files are stored and streamable with HTTP Range support
    const { response: filesRes } = await callWorker(env, `/api/files?jobId=${created.job.id}`);
    const files = (await filesRes.json()) as { items: FileRecord[]; total: number };
    expect(files.items).toHaveLength(2);

    const fileId = files.items[0].id;
    const { response: rangeRes } = await callWorker(env, `/api/files/${fileId}/content`, {
      headers: { range: 'bytes=0-34' },
    });
    expect(rangeRes.status).toBe(206);
    expect(await rangeRes.text()).toBe('VTGrab MOCK OBJECT - NOT REAL MEDIA');

    // 5. Re-downloading the same episode in a second job updates the file row cleanly
    const { response: secondJobRes, pending: secondPending } = await callWorker(env, '/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seriesId: analyzed.series.id,
        selection: { mode: 'ids', episodeIds: [picked[0]] },
        options: { quality: '720p', container: 'mp4', concurrency: 1, prefix: 'cf-deploy' },
      }),
    });
    expect(secondJobRes.status).toBe(201);
    const secondCreated = (await secondJobRes.json()) as JobDetail;
    await Promise.all(secondPending);
    await waitFor('second job completion', async () => {
      const { response } = await callWorker(env, `/api/jobs/${secondCreated.job.id}`);
      const detail = (await response.json()) as JobDetail;
      return detail.job.status === 'completed';
    });
  });
});
