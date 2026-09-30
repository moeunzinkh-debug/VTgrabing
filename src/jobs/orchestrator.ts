import { nowIso, Repository } from '../db/repository';
import type { Env } from '../env';
import { maxAttempts, num } from '../env';
import { episodeLabel } from '../core/ids';
import { resolveDownloadProvider } from '../providers/download/registry';
import { fetchRemoteObject } from '../providers/download/remote';
import type { DownloadRequest } from '../providers/download/types';
import { writeStreamToR2 } from '../providers/storage/r2';
import type {
  EpisodeRecord,
  FileRecord,
  JobItemRecord,
  JobRecord,
  SeriesRecord,
} from '../shared/types';

/** Origin an external download service must call back on. */
export function callbackOrigin(env: Env): string {
  return (
    env.DOWNLOAD_CALLBACK_URL?.replace(/\/+$/, '') ||
    env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ||
    ''
  );
}

export const THROTTLE_DELAY_SECONDS = 5;
export const MAX_THROTTLE_REQUEUE = 600;
export const RETRY_DELAY_SECONDS = 30;

export interface StreamCompletionInput {
  item: JobItemRecord;
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
  checksumSha256?: string;
  providerKey: string;
}

function pickStreamUrl(episode: EpisodeRecord, quality: string): string | undefined {
  const exact = episode.streams.find((stream) => stream.quality.toLowerCase() === quality.toLowerCase());
  return (exact ?? episode.streams[0])?.url;
}

export function buildDownloadRequest(
  item: JobItemRecord,
  job: JobRecord,
  episode: EpisodeRecord,
  series: SeriesRecord,
  callbackOrigin: string,
): DownloadRequest {
  return {
    jobItemId: item.id,
    jobId: job.id,
    seriesId: series.id,
    seriesTitle: series.title,
    episodeId: episode.id,
    episodeIndex: episode.episodeIndex,
    episodeTitle: episode.title,
    sourceUrl: episode.sourceUrl,
    streamUrl: pickStreamUrl(episode, item.quality),
    quality: item.quality,
    container: item.container,
    objectKey: item.objectKey,
    filename: item.objectKey.split('/').pop() ?? item.objectKey,
    callbackOrigin,
  };
}

/**
 * Persist a finished media stream: stream it into R2, insert the `files` row and
 * flip the job item to `completed`. Used by the inline provider path, the signed
 * provider callback and the scheduled poll - so all three behave identically.
 */
export async function completeJobItemWithStream(
  env: Env,
  repo: Repository,
  input: StreamCompletionInput,
): Promise<FileRecord> {
  const { item } = input;

  // Idempotent: a callback racing with a poll must not create a duplicate file.
  const fresh = await repo.getJobItem(item.id);
  if (fresh?.status === 'completed' && fresh.fileId) {
    const existing = await repo.getFile(fresh.fileId);
    if (existing) return existing;
  }

  const [episode, series] = await Promise.all([
    repo.getEpisode(item.episodeId),
    repo.getSeries(item.seriesId),
  ]);

  const written = await writeStreamToR2(env.FILES, item.objectKey, input.stream, {
    contentType: input.contentType,
    customMetadata: {
      jobId: item.jobId,
      jobItemId: item.id,
      episodeId: item.episodeId,
      episodeIndex: String(episode?.episodeIndex ?? 0),
      episodeLabel: episodeLabel(episode?.episodeIndex ?? 0),
      seriesTitle: series?.title ?? '',
      quality: item.quality,
      container: item.container,
      provider: input.providerKey,
    },
  });

  const file = await repo.insertFile({
    jobId: item.jobId,
    jobItemId: item.id,
    seriesId: item.seriesId,
    episodeId: item.episodeId,
    bucket: 'FILES',
    objectKey: written.key,
    filename: item.objectKey.split('/').pop() ?? item.objectKey,
    contentType: input.contentType,
    size: written.size,
    etag: written.etag,
    checksumSha256: input.checksumSha256 ?? null,
    quality: item.quality,
    container: item.container,
    durationSeconds: episode?.durationSeconds ?? null,
    provider: input.providerKey,
    metadata: {
      multipart: written.multipart,
      parts: written.parts,
      contentLengthHeader: input.contentLength ?? null,
      episodeIndex: episode?.episodeIndex ?? null,
      seriesTitle: series?.title ?? null,
    },
  });

  await repo.updateJobItem(item.id, {
    status: 'completed',
    progress: 100,
    bytes: written.size,
    fileId: file.id,
    provider: input.providerKey,
    error: null,
    finishedAt: nowIso(),
  });

  await repo.appendEvent({
    jobId: item.jobId,
    jobItemId: item.id,
    level: 'info',
    message: `Stored ${(written.size / 1024 / 1024).toFixed(2)} MiB at ${written.key}${
      written.multipart ? ` (${written.parts} parts)` : ''
    }`,
    data: { fileId: file.id, size: written.size, etag: written.etag },
  });

  return file;
}

/** `job.init`: mark the job as running. */
export async function startJob(_env: Env, repo: Repository, jobId: string): Promise<void> {
  const job = await repo.getJob(jobId);
  if (!job || job.status === 'cancelled') return;
  await repo.updateJob(jobId, { status: 'running', startedAt: job.startedAt ?? nowIso() });
  await repo.appendEvent({
    jobId,
    level: 'info',
    message: `Job started with provider "${job.options.provider ?? 'default'}"`,
  });
}

/**
 * `job.item`: download one episode through the resolved provider and store it.
 * Errors are retried through the queue (with a delay) up to `MAX_ATTEMPTS`.
 */
export async function runDownloadJobItem(
  env: Env,
  repo: Repository,
  message: { jobId: string; jobItemId: string; attempt: number; throttled: number },
): Promise<void> {
  const item = await repo.getJobItem(message.jobItemId);
  if (!item) {
    console.warn(`[vtgrab] job item ${message.jobItemId} no longer exists, dropping message`);
    return;
  }
  if (item.status === 'completed' || item.status === 'cancelled') return;

  const job = await repo.getJob(item.jobId);
  if (!job) return;
  if (job.status === 'cancelled') {
    await repo.updateJobItem(item.id, { status: 'cancelled', error: 'Job cancelled', finishedAt: nowIso() });
    return;
  }

  // ---- local concurrency limiter -------------------------------------------
  const concurrency = Math.max(1, job.options.concurrency || 1);
  const active = await repo.countItemsByStatus(job.id, ['downloading']);
  if (active >= concurrency && message.throttled < MAX_THROTTLE_REQUEUE) {
    await env.JOB_QUEUE.send(
      {
        type: 'job.item',
        jobId: job.id,
        jobItemId: item.id,
        attempt: message.attempt,
        throttled: message.throttled + 1,
      },
      { delaySeconds: THROTTLE_DELAY_SECONDS },
    );
    return;
  }

  const [episode, series] = await Promise.all([
    repo.getEpisode(item.episodeId),
    repo.getSeries(item.seriesId),
  ]);

  if (!episode || !series) {
    await repo.updateJobItem(item.id, {
      status: 'failed',
      error: 'Episode or series metadata is missing',
      finishedAt: nowIso(),
    });
    await repo.appendEvent({
      jobId: job.id,
      jobItemId: item.id,
      level: 'error',
      message: 'Episode or series metadata is missing',
    });
    await finalizeJob(env, repo, job.id);
    return;
  }

  const provider = resolveDownloadProvider(env, job.options.provider);
  const attempt = item.attempts + 1;
  const timestamp = nowIso();

  await repo.updateJobItem(item.id, {
    status: 'downloading',
    attempts: attempt,
    progress: Math.max(item.progress, 5),
    startedAt: item.startedAt ?? timestamp,
    provider: provider.key,
    error: null,
    finishedAt: null,
  });
  await repo.appendEvent({
    jobId: job.id,
    jobItemId: item.id,
    level: 'info',
    message: `Downloading episode ${episode.episodeIndex} at ${item.quality} via ${provider.key} (attempt ${attempt})`,
  });

  try {
    const result = await provider.start(
      buildDownloadRequest(item, job, episode, series, callbackOrigin(env)),
      env,
    );

    if (result.kind === 'stream') {
      await completeJobItemWithStream(env, repo, {
        item,
        stream: result.stream,
        contentType: result.contentType,
        contentLength: result.contentLength,
        checksumSha256: result.checksumSha256,
        providerKey: provider.key,
      });
    } else {
      await repo.updateJobItem(item.id, {
        status: 'downloading',
        progress: 10,
        providerRef: result.providerRef,
        provider: provider.key,
      });
      await repo.appendEvent({
        jobId: job.id,
        jobItemId: item.id,
        level: 'info',
        message: `Queued on ${provider.key} as ${result.providerRef}; waiting for callback or poll`,
        data: { providerRef: result.providerRef },
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const limit = maxAttempts(env);
    if (attempt < limit) {
      await repo.updateJobItem(item.id, { status: 'pending', progress: 0, error: reason });
      await env.JOB_QUEUE.send(
        {
          type: 'job.item',
          jobId: job.id,
          jobItemId: item.id,
          attempt: attempt + 1,
          throttled: 0,
        },
        { delaySeconds: RETRY_DELAY_SECONDS },
      );
      await repo.appendEvent({
        jobId: job.id,
        jobItemId: item.id,
        level: 'warn',
        message: `Attempt ${attempt}/${limit} failed, retrying: ${reason}`,
      });
    } else {
      await repo.updateJobItem(item.id, {
        status: 'failed',
        progress: 0,
        error: reason,
        finishedAt: nowIso(),
      });
      await repo.appendEvent({
        jobId: job.id,
        jobItemId: item.id,
        level: 'error',
        message: `Failed after ${attempt} attempt(s): ${reason}`,
      });
    }
  } finally {
    await finalizeJob(env, repo, job.id);
  }
}

/** Recompute counters and close the job when nothing is in flight any more. */
export async function finalizeJob(_env: Env, repo: Repository, jobId: string): Promise<JobRecord> {
  const job = await repo.recomputeJob(jobId);
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'partial') {
    const alreadyClosed = await repo.listEvents(jobId, 5);
    const closed = alreadyClosed.some((event) => event.message.startsWith('Job closed'));
    if (!closed) {
      await repo.appendEvent({
        jobId,
        level: job.status === 'completed' ? 'info' : 'warn',
        message: `Job closed as ${job.status} (${job.completedItems}/${job.totalItems} completed, ${job.failedItems} failed, ${job.cancelledItems} cancelled)`,
      });
    }
  }
  return job;
}

/**
 * Scheduled maintenance:
 *  - poll deferred remote jobs that are ready / failed / cancelled
 *  - fail items that have been `downloading` for far too long
 */
export async function runMaintenance(env: Env, repo: Repository, limit = 50): Promise<{
  polled: number;
  completed: number;
  failed: number;
}> {
  const staleMinutes = num(env, 'STALE_ITEM_MINUTES', 20);
  const staleCutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const hardCutoff = new Date(Date.now() - staleMinutes * 4 * 60_000).toISOString();

  const staleItems = await repo.listStaleItems(staleCutoff, limit);
  const hardStaleIds = new Set(
    (await repo.listStaleItems(hardCutoff, limit)).map((item) => item.id),
  );

  let completed = 0;
  let failed = 0;

  for (const item of staleItems) {
    const job = await repo.getJob(item.jobId);
    if (!job || job.status === 'cancelled') continue;

    const provider = resolveDownloadProvider(env, item.provider ?? job.options.provider);

    if (!provider.status) {
      if (hardStaleIds.has(item.id)) {
        await repo.updateJobItem(item.id, {
          status: 'failed',
          error: `Provider "${provider.key}" timed out after ${staleMinutes * 4} minutes`,
          finishedAt: nowIso(),
        });
        failed += 1;
      }
      continue;
    }

    if (!item.providerRef) {
      if (hardStaleIds.has(item.id)) {
        await repo.updateJobItem(item.id, {
          status: 'failed',
          error: `No provider reference after ${staleMinutes * 4} minutes`,
          finishedAt: nowIso(),
        });
        failed += 1;
      }
      continue;
    }

    try {
      const status = await provider.status(item.providerRef, env);
      if (status.status === 'ready' && status.downloadUrl) {
        const object = await fetchRemoteObject(status.downloadUrl, env);
        await completeJobItemWithStream(env, repo, {
          item,
          stream: object.stream,
          contentType: status.contentType ?? object.contentType ?? 'application/octet-stream',
          contentLength: status.bytes ?? object.contentLength,
          providerKey: provider.key,
        });
        completed += 1;
      } else if (status.status === 'failed') {
        await repo.updateJobItem(item.id, {
          status: 'failed',
          error: status.error ?? 'Remote provider reported a failure',
          finishedAt: nowIso(),
        });
        failed += 1;
      } else if (status.status === 'cancelled') {
        await repo.updateJobItem(item.id, {
          status: 'cancelled',
          error: status.error ?? 'Cancelled by remote provider',
          finishedAt: nowIso(),
        });
      } else if (hardStaleIds.has(item.id)) {
        await repo.updateJobItem(item.id, {
          status: 'failed',
          error: `Remote job still "${status.status}" after ${staleMinutes * 4} minutes`,
          finishedAt: nowIso(),
        });
        failed += 1;
      } else if (typeof status.progress === 'number') {
        await repo.updateJobItem(item.id, { progress: Math.min(95, Math.max(10, status.progress)) });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await repo.appendEvent({
        jobId: item.jobId,
        jobItemId: item.id,
        level: 'warn',
        message: `Status poll failed: ${reason}`,
      });
      if (hardStaleIds.has(item.id)) {
        await repo.updateJobItem(item.id, { status: 'failed', error: reason, finishedAt: nowIso() });
        failed += 1;
      }
    } finally {
      await finalizeJob(env, repo, item.jobId);
    }
  }

  return { polled: staleItems.length, completed, failed };
}
