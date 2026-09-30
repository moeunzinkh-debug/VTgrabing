import { env, SELF } from 'cloudflare:test';
import { Repository } from '../src/db/repository';
import type { Env } from '../src/env';

export const testEnv: Env = env;
export const repository = (): Repository => new Repository(env);

const BASE = 'https://vtgrab.test';

export function request(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, init);
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(path, init);
  return (await response.json()) as T;
}

export function postJson(path: string, body: unknown): Promise<Response> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Analyze a mock URL and return the created series + episodes. */
export async function analyze(url = 'https://mock.local/series/demo'): Promise<{
  series: { id: string; title: string; episodeCount: number };
  episodes: Array<{ id: string; episodeIndex: number; title: string }>;
}> {
  const response = await postJson('/api/analyze', { url });
  if (!response.ok) throw new Error(`analyze failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as never;
}

export async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Insert a job and its items straight into D1, without publishing queue messages.
 * Used by tests that need a deterministic starting state (cancel/retry/callback).
 */
export async function seedJob(
  itemCount = 2,
  concurrency = 4,
  initialStatus: 'pending' | 'failed' = 'pending',
): Promise<{
  jobId: string;
  itemIds: string[];
  seriesId: string;
  objectKeys: string[];
  episodeIds: string[];
}> {
  const { series, episodes } = await analyze(`https://mock.local/seed/${Date.now()}/${itemCount}`);
  const repo = repository();
  const picks = episodes.slice(0, itemCount);
  const timestamp = new Date().toISOString();
  const jobId = `job_seed_${Math.random().toString(36).slice(2, 10)}`;

  await env.DB.prepare(
    `INSERT INTO jobs (id, series_id, status, selection, options, total_items, completed_items,
                       failed_items, cancelled_items, error, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, 0, 0, 0, NULL, ?, ?)`,
  )
    .bind(
      jobId,
      series.id,
      JSON.stringify({ mode: 'ids', episodeIds: picks.map((episode) => episode.id) }),
      JSON.stringify({
        quality: '720p',
        container: 'mp4',
        concurrency,
        prefix: 'seed',
        provider: 'mock',
      }),
      picks.length,
      timestamp,
      timestamp,
    )
    .run();

  const itemIds: string[] = [];
  const objectKeys: string[] = [];
  for (const [index, episode] of picks.entries()) {
    const itemId = `jit_seed_${Math.random().toString(36).slice(2, 10)}`;
    const objectKey = `seed/${jobId}/ep-${index + 1}.mp4`;
    await env.DB.prepare(
      `INSERT INTO job_items (id, job_id, episode_id, series_id, position, status, progress, attempts,
                              quality, container, object_key, bytes, error, file_id, provider,
                              provider_ref, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, '720p', 'mp4', ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
      .bind(
        itemId,
        jobId,
        episode.id,
        series.id,
        index + 1,
        initialStatus,
        initialStatus === 'failed' ? 1 : 0,
        objectKey,
        timestamp,
      )
      .run();
    itemIds.push(itemId);
    objectKeys.push(objectKey);
  }

  // Sanity check: the repository sees what we just wrote.
  const job = await repo.getJob(jobId);
  if (!job) throw new Error('seedJob failed: job was not persisted');

  return {
    jobId,
    itemIds,
    seriesId: series.id,
    objectKeys,
    episodeIds: picks.map((episode) => episode.id),
  };
}
