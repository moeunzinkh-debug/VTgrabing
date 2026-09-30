import { badRequest, conflict, notFound } from '../core/errors';
import { episodeLabel, slugify } from '../core/ids';
import { describeSelection, resolveSelection } from '../core/selection';
import type { Env } from '../env';
import { defaultConcurrency } from '../env';
import { Repository } from '../db/repository';
import { resolveDownloadProvider } from '../providers/download/registry';
import type { DownloadProvider } from '../providers/download/types';
import { sendMessages } from '../queue/messages';
import type { QueueMessage } from '../queue/messages';
import type { JobDetail, JobOptions, JobRecord } from '../shared/types';
import type { CreateJobInput, JobOptionsInput } from '../core/validate';

export function buildJobOptions(env: Env, input: JobOptionsInput = {}): JobOptions {
  const options: JobOptions = {
    quality: input.quality ?? env.DEFAULT_QUALITY ?? '1080p',
    container: (input.container ?? env.DEFAULT_CONTAINER ?? 'mp4').toLowerCase(),
    concurrency: input.concurrency ?? defaultConcurrency(env),
    prefix: (input.prefix ?? 'vtgrab').replace(/^\/+|\/+$/g, '') || 'vtgrab',
  };
  if (input.provider) options.provider = input.provider;
  return options;
}

/**
 * Object store layout:
 *   <prefix>/<series-slug>/S01E<nn>-<episode-slug>[.mock].<container>
 */
export function buildObjectKey(input: {
  prefix: string;
  seriesTitle: string;
  episodeIndex: number;
  episodeTitle: string;
  container: string;
  mock?: boolean;
}): string {
  const series = slugify(input.seriesTitle, 50);
  const episode = slugify(input.episodeTitle, 60);
  const suffix = input.mock ? '.mock' : '';
  return `${input.prefix}/${series}/${episodeLabel(input.episodeIndex)}-${episode}${suffix}.${input.container}`;
}

export class JobService {
  constructor(private readonly env: Env, private readonly repo: Repository) {}

  /** Analyze output persisted as a series + episodes. */
  async createJob(input: CreateJobInput): Promise<JobDetail> {
    const series = await this.repo.getSeries(input.seriesId);
    if (!series) throw notFound(`Series ${input.seriesId} not found`);

    const episodes = await this.repo.listEpisodes(series.id);
    if (episodes.length === 0) {
      throw badRequest('Series has no episodes. Run analyze again.');
    }

    const selectedIds = new Set(resolveSelection(episodes, input.selection).map((pick) => pick.id));
    const selected = episodes.filter((episode) => selectedIds.has(episode.id));
    if (selected.length === 0) {
      throw badRequest('Selection resolved to zero episodes.', {
        selection: input.selection,
        available: episodes.length,
      });
    }

    const options = buildJobOptions(this.env, input.options);
    // Fail fast (before writing anything) when no usable provider is configured.
    const provider = resolveDownloadProvider(this.env, options.provider);
    options.provider = provider.key;
    const isMock = provider.key === 'mock';

    const job = await this.repo.createJob({
      seriesId: series.id,
      selection: input.selection,
      options,
      items: selected.map((episode, index) => ({
        episodeId: episode.id,
        seriesId: series.id,
        position: index + 1,
        quality: options.quality,
        container: options.container,
        objectKey: buildObjectKey({
          prefix: options.prefix,
          seriesTitle: series.title,
          episodeIndex: episode.episodeIndex,
          episodeTitle: episode.title,
          container: options.container,
          mock: isMock,
        }),
      })),
    });

    await this.repo.appendEvent({
      jobId: job.id,
      level: 'info',
      message: `Job created for ${describeSelection(input.selection)} (${selected.length} item(s))`,
      data: { selection: input.selection, options, provider: provider.key },
    });

    await this.dispatch(job, provider);
    return this.repo.jobDetail(job.id);
  }

  /** Push one queue message per pending item, grouped by the configured batch size. */
  async dispatch(job: JobRecord, provider: DownloadProvider = resolveDownloadProvider(this.env, job.options.provider)): Promise<number> {
    const itemIds = await this.repo.listPendingItemIds(job.id);
    if (itemIds.length === 0) return 0;

    const messages: QueueMessage[] = [
      { type: 'job.init', jobId: job.id },
      ...itemIds.map((jobItemId) => ({ type: 'job.item' as const, jobId: job.id, jobItemId, attempt: 1, throttled: 0 })),
    ];

    const sent = await sendMessages(this.env.JOB_QUEUE, messages, {
      batchSize: Math.max(1, job.options.concurrency),
    });

    await this.repo.appendEvent({
      jobId: job.id,
      level: 'info',
      message: `Dispatched ${itemIds.length} queue message(s) to provider "${provider.key}"`,
      data: { provider: provider.key, concurrency: job.options.concurrency },
    });
    return sent;
  }

  async getDetail(jobId: string): Promise<JobDetail> {
    return this.repo.jobDetail(jobId);
  }

  /** Cancel every unfinished item, ask the provider to stop deferred work. */
  async cancel(jobId: string): Promise<JobDetail> {
    const job = await this.repo.requireJob(jobId);
    if (job.status === 'completed' || job.status === 'cancelled') {
      throw conflict(`Job ${jobId} is already ${job.status}`);
    }

    const open = await this.repo.listItemsByStatus(job.id, ['pending', 'downloading']);
    await this.repo.updateItemsByStatus(job.id, ['pending', 'downloading'], {
      status: 'cancelled',
      error: 'Cancelled by user',
      finishedAt: new Date().toISOString(),
    });

    const provider = resolveDownloadProviderSafe(this.env, job.options.provider);
    let cancelledRemotely = 0;
    if (provider?.cancel) {
      for (const item of open) {
        if (!item.providerRef) continue;
        try {
          await provider.cancel(item.providerRef, this.env);
          cancelledRemotely += 1;
        } catch (error) {
          await this.repo.appendEvent({
            jobId: job.id,
            jobItemId: item.id,
            level: 'warn',
            message: `Remote cancel failed: ${(error as Error).message}`,
          });
        }
      }
    }

    await this.repo.updateJob(job.id, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
    });
    await this.repo.appendEvent({
      jobId: job.id,
      level: 'info',
      message: `Job cancelled (${open.length} item(s) stopped, ${cancelledRemotely} remote cancel(s))`,
    });

    return this.repo.jobDetail(job.id);
  }

  /** Re-queue every failed/cancelled item of a job. */
  async retry(jobId: string): Promise<JobDetail> {
    const job = await this.repo.requireJob(jobId);
    const retryable = await this.repo.listItemsByStatus(job.id, ['failed', 'cancelled']);
    if (retryable.length === 0) {
      throw conflict('Job has no failed or cancelled items to retry');
    }

    await this.repo.updateItemsByStatus(job.id, ['failed', 'cancelled'], {
      status: 'pending',
      progress: 0,
      attempts: 0,
      error: null,
      finishedAt: null,
    });
    await this.repo.updateJob(job.id, { status: 'pending', finishedAt: null, error: null });
    await this.repo.appendEvent({
      jobId: job.id,
      level: 'info',
      message: `Retrying ${retryable.length} item(s)`,
    });

    await sendMessages(
      this.env.JOB_QUEUE,
      retryable.map((item) => ({
        type: 'job.item' as const,
        jobId: job.id,
        jobItemId: item.id,
        attempt: 1,
        throttled: 0,
      })),
      { batchSize: Math.max(1, job.options.concurrency) },
    );

    return this.repo.jobDetail(job.id);
  }
}

/** Resolve the provider for a job, returning null instead of throwing. */
function resolveDownloadProviderSafe(env: Env, key?: string): DownloadProvider | null {
  try {
    return resolveDownloadProvider(env, key);
  } catch {
    return null;
  }
}
