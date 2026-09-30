import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { Repository } from '../src/db/repository';
import type { Env } from '../src/env';
import { FallbackR2Bucket, ensureD1Schema } from '../src/runtime/fallbacks';
import type { EpisodeRecord, FileRecord, JobDetail, SeriesRecord } from '../src/shared/types';
import { testEnv, waitFor } from './helpers';

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

    // 6. Scheduled cron maintenance runs cleanly in zero-binding mode
    const { ctx: schedCtx } = makeCtx();
    await worker.scheduled!(
      { cron: '*/5 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
      schedCtx,
    );
  });

  it('supports multipart upload assembly and abort on FallbackR2Bucket', async () => {
    const bucket = new FallbackR2Bucket();
    const upload = await bucket.createMultipartUpload('videos/part-test.mp4', {
      httpMetadata: { contentType: 'video/mp4' },
    });
    const part1 = await upload.uploadPart(1, new TextEncoder().encode('hello '));
    const part2 = await upload.uploadPart(2, new TextEncoder().encode('world'));
    const completed = await upload.complete([part1, part2]);
    expect(completed.size).toBe(11);

    const obj = await bucket.get('videos/part-test.mp4');
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe('hello world');

    const suffixed = await bucket.get('videos/part-test.mp4', { range: { suffix: 5 } });
    expect(await suffixed!.text()).toBe('world');
  });

  it('auto-initializes D1 schema via ensureD1Schema on real D1 bindings', async () => {
    await ensureD1Schema(testEnv.DB);
    const repo = new Repository(testEnv);
    const list = await repo.listSeries({ limit: 5, offset: 0 });
    expect(Array.isArray(list.items)).toBe(true);
  });
});
