import type { Env } from '../env';
import { parseJson, stringifyJson } from '../core/json';
import { newId } from '../core/ids';
import { notFound } from '../core/errors';
import type {
  EpisodeRecord,
  FileRecord,
  JobDetail,
  JobEventLevel,
  JobEventRecord,
  JobItemRecord,
  JobItemStatus,
  JobItemView,
  JobListItem,
  JobOptions,
  JobRecord,
  JobStatus,
  SelectionDescriptor,
  SeriesRecord,
  StreamInfo,
} from '../shared/types';

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case, exactly as stored in D1)
// ---------------------------------------------------------------------------

interface SeriesRow {
  id: string;
  source_key: string;
  source_url: string;
  canonical_url: string;
  title: string;
  synopsis: string | null;
  poster_url: string | null;
  episode_count: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface EpisodeRow {
  id: string;
  series_id: string;
  episode_index: number;
  title: string;
  source_url: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  streams: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  series_id: string;
  status: string;
  selection: string;
  options: string;
  total_items: number;
  completed_items: number;
  failed_items: number;
  cancelled_items: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface JobItemRow {
  id: string;
  job_id: string;
  episode_id: string;
  series_id: string;
  position: number;
  status: string;
  progress: number;
  attempts: number;
  quality: string;
  container: string;
  object_key: string;
  bytes: number;
  error: string | null;
  file_id: string | null;
  provider: string | null;
  provider_ref: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface JobItemViewRow extends JobItemRow {
  episode_index: number;
  episode_title: string;
  episode_url: string;
}

interface FileRow {
  id: string;
  job_id: string | null;
  job_item_id: string | null;
  series_id: string | null;
  episode_id: string | null;
  bucket: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  etag: string | null;
  checksum_sha256: string | null;
  quality: string | null;
  container: string | null;
  duration_seconds: number | null;
  provider: string;
  metadata: string;
  created_at: string;
}

interface JobEventRow {
  id: number;
  job_id: string | null;
  job_item_id: string | null;
  level: string;
  message: string;
  data: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapSeries(row: SeriesRow): SeriesRecord {
  return {
    id: row.id,
    sourceKey: row.source_key,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    synopsis: row.synopsis,
    posterUrl: row.poster_url,
    episodeCount: row.episode_count,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapEpisode(row: EpisodeRow): EpisodeRecord {
  return {
    id: row.id,
    seriesId: row.series_id,
    episodeIndex: row.episode_index,
    title: row.title,
    sourceUrl: row.source_url,
    durationSeconds: row.duration_seconds,
    thumbnailUrl: row.thumbnail_url,
    streams: parseJson<StreamInfo[]>(row.streams, []),
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    seriesId: row.series_id,
    status: row.status as JobStatus,
    selection: parseJson<SelectionDescriptor>(row.selection, { mode: 'all' }),
    options: parseJson<JobOptions>(row.options, {
      quality: '1080p',
      container: 'mp4',
      concurrency: 4,
      prefix: 'vtgrab',
    }),
    totalItems: row.total_items,
    completedItems: row.completed_items,
    failedItems: row.failed_items,
    cancelledItems: row.cancelled_items,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function mapJobItem(row: JobItemRow): JobItemRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    episodeId: row.episode_id,
    seriesId: row.series_id,
    position: row.position,
    status: row.status as JobItemStatus,
    progress: row.progress,
    attempts: row.attempts,
    quality: row.quality,
    container: row.container,
    objectKey: row.object_key,
    bytes: row.bytes,
    error: row.error,
    fileId: row.file_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function mapJobItemView(row: JobItemViewRow): JobItemView {
  const base = mapJobItem(row);
  return {
    ...base,
    episodeIndex: row.episode_index,
    episodeTitle: row.episode_title,
    episodeUrl: row.episode_url,
    filename: row.object_key.split('/').pop() ?? row.object_key,
  };
}

export function mapFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    jobItemId: row.job_item_id,
    seriesId: row.series_id,
    episodeId: row.episode_id,
    bucket: row.bucket,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    etag: row.etag,
    checksumSha256: row.checksum_sha256,
    quality: row.quality,
    container: row.container,
    durationSeconds: row.duration_seconds,
    provider: row.provider,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
  };
}

function mapJobEvent(row: JobEventRow): JobEventRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    jobItemId: row.job_item_id,
    level: row.level as JobEventLevel,
    message: row.message,
    data: parseJson<Record<string, unknown> | null>(row.data, null),
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface NewEpisodeInput {
  episodeIndex: number;
  title: string;
  sourceUrl: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  streams: StreamInfo[];
  metadata?: Record<string, unknown>;
}

export interface UpsertSeriesInput {
  sourceKey: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  synopsis: string | null;
  posterUrl: string | null;
  metadata: Record<string, unknown>;
}

export interface NewJobItemInput {
  episodeId: string;
  seriesId: string;
  position: number;
  quality: string;
  container: string;
  objectKey: string;
}

export interface InsertFileInput {
  jobId: string | null;
  jobItemId: string | null;
  seriesId: string | null;
  episodeId: string | null;
  bucket: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  etag: string | null;
  checksumSha256: string | null;
  quality: string | null;
  container: string | null;
  durationSeconds: number | null;
  provider: string;
  metadata: Record<string, unknown>;
}

export type JobItemPatch = Partial<
  Pick<
    JobItemRecord,
    | 'status'
    | 'progress'
    | 'attempts'
    | 'bytes'
    | 'error'
    | 'fileId'
    | 'provider'
    | 'providerRef'
    | 'startedAt'
    | 'finishedAt'
  >
>;

export type JobPatch = Partial<
  Pick<JobRecord, 'status' | 'error' | 'startedAt' | 'finishedAt' | 'completedItems' | 'failedItems' | 'cancelledItems' | 'totalItems'>
>;

export class Repository {
  constructor(private readonly env: Env) {}

  private get db(): D1Database {
    return this.env.DB;
  }

  // ------------------------------- series ----------------------------------

  async upsertSeries(input: UpsertSeriesInput): Promise<SeriesRecord> {
    const existing = await this.getSeriesByCanonicalUrl(input.canonicalUrl);
    const timestamp = nowIso();
    if (existing) {
      await this.db
        .prepare(
          `UPDATE series SET source_key = ?, source_url = ?, title = ?, synopsis = ?,
                  poster_url = ?, metadata = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(
          input.sourceKey,
          input.sourceUrl,
          input.title,
          input.synopsis,
          input.posterUrl,
          stringifyJson(input.metadata),
          timestamp,
          existing.id,
        )
        .run();
      return (await this.getSeries(existing.id))!;
    }

    const id = newId('ser');
    await this.db
      .prepare(
        `INSERT INTO series (id, source_key, source_url, canonical_url, title, synopsis,
                             poster_url, episode_count, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        id,
        input.sourceKey,
        input.sourceUrl,
        input.canonicalUrl,
        input.title,
        input.synopsis,
        input.posterUrl,
        stringifyJson(input.metadata),
        timestamp,
        timestamp,
      )
      .run();
    return (await this.getSeries(id))!;
  }

  async getSeries(id: string): Promise<SeriesRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM series WHERE id = ?`).bind(id).first<SeriesRow>();
    return row ? mapSeries(row) : null;
  }

  async getSeriesByCanonicalUrl(canonicalUrl: string): Promise<SeriesRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM series WHERE canonical_url = ?`)
      .bind(canonicalUrl)
      .first<SeriesRow>();
    return row ? mapSeries(row) : null;
  }

  async getSeriesBySourceUrl(sourceUrl: string): Promise<SeriesRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM series WHERE source_url = ?`)
      .bind(sourceUrl)
      .first<SeriesRow>();
    return row ? mapSeries(row) : null;
  }

  async listSeries(options: {
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: SeriesRecord[]; total: number }> {
    const like = options.q ? `%${options.q}%` : null;
    const totalRow = await this.db
      .prepare(like ? `SELECT COUNT(*) AS total FROM series WHERE title LIKE ?` : `SELECT COUNT(*) AS total FROM series`)
      .bind(...(like ? [like] : []))
      .first<{ total: number }>();
    const rows = await this.db
      .prepare(
        like
          ? `SELECT * FROM series WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`
          : `SELECT * FROM series ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...(like ? [like, options.limit, options.offset] : [options.limit, options.offset]))
      .all<SeriesRow>();
    return { items: rows.results.map(mapSeries), total: totalRow?.total ?? 0 };
  }

  async deleteSeries(id: string): Promise<void> {
    await this.db.prepare(`DELETE FROM series WHERE id = ?`).bind(id).run();
  }

  // ------------------------------ episodes ---------------------------------

  /**
   * Persist the freshly extracted episode list. Existing episodes are updated,
   * new ones inserted, and episodes that disappeared from the source removed.
   */
  async replaceEpisodes(seriesId: string, episodes: NewEpisodeInput[]): Promise<EpisodeRecord[]> {
    const timestamp = nowIso();
    const statements: D1PreparedStatement[] = [];
    const keepIds: string[] = [];

    const existingRows = await this.db
      .prepare(`SELECT id, episode_index FROM episodes WHERE series_id = ?`)
      .bind(seriesId)
      .all<{ id: string; episode_index: number }>();
    const byIndex = new Map(existingRows.results.map((row) => [row.episode_index, row.id]));

    for (const episode of episodes) {
      const existingId = byIndex.get(episode.episodeIndex);
      const id = existingId ?? newId('ep');
      keepIds.push(id);
      if (existingId) {
        statements.push(
          this.db
            .prepare(
              `UPDATE episodes SET title = ?, source_url = ?, duration_seconds = ?, thumbnail_url = ?,
                                   streams = ?, metadata = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(
              episode.title,
              episode.sourceUrl,
              episode.durationSeconds,
              episode.thumbnailUrl,
              stringifyJson(episode.streams),
              stringifyJson(episode.metadata ?? {}),
              timestamp,
              id,
            ),
        );
      } else {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO episodes (id, series_id, episode_index, title, source_url, duration_seconds,
                                     thumbnail_url, streams, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              id,
              seriesId,
              episode.episodeIndex,
              episode.title,
              episode.sourceUrl,
              episode.durationSeconds,
              episode.thumbnailUrl,
              stringifyJson(episode.streams),
              stringifyJson(episode.metadata ?? {}),
              timestamp,
              timestamp,
            ),
        );
      }
    }

    if (keepIds.length > 0) {
      const placeholders = keepIds.map(() => '?').join(', ');
      statements.push(
        this.db
          .prepare(`DELETE FROM episodes WHERE series_id = ? AND id NOT IN (${placeholders})`)
          .bind(seriesId, ...keepIds),
      );
    } else {
      statements.push(this.db.prepare(`DELETE FROM episodes WHERE series_id = ?`).bind(seriesId));
    }

    statements.push(
      this.db
        .prepare(`UPDATE series SET episode_count = ?, updated_at = ? WHERE id = ?`)
        .bind(episodes.length, timestamp, seriesId),
    );

    await this.db.batch(statements);
    return this.listEpisodes(seriesId);
  }

  async listEpisodes(seriesId: string): Promise<EpisodeRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM episodes WHERE series_id = ? ORDER BY episode_index ASC`)
      .bind(seriesId)
      .all<EpisodeRow>();
    return rows.results.map(mapEpisode);
  }

  async getEpisodesByIds(seriesId: string, ids: string[]): Promise<EpisodeRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await this.db
      .prepare(
        `SELECT * FROM episodes WHERE series_id = ? AND id IN (${placeholders}) ORDER BY episode_index ASC`,
      )
      .bind(seriesId, ...ids)
      .all<EpisodeRow>();
    return rows.results.map(mapEpisode);
  }

  async getEpisode(id: string): Promise<EpisodeRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM episodes WHERE id = ?`).bind(id).first<EpisodeRow>();
    return row ? mapEpisode(row) : null;
  }

  // -------------------------------- jobs -----------------------------------

  async createJob(input: {
    seriesId: string;
    selection: SelectionDescriptor;
    options: JobOptions;
    items: NewJobItemInput[];
  }): Promise<JobRecord> {
    const timestamp = nowIso();
    const jobId = newId('job');
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO jobs (id, series_id, status, selection, options, total_items, completed_items,
                             failed_items, cancelled_items, error, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, 0, 0, 0, NULL, ?, ?)`,
        )
        .bind(
          jobId,
          input.seriesId,
          stringifyJson(input.selection),
          stringifyJson(input.options),
          input.items.length,
          timestamp,
          timestamp,
        ),
    ];

    input.items.forEach((item) => {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO job_items (id, job_id, episode_id, series_id, position, status, progress, attempts,
                                    quality, container, object_key, bytes, error, file_id, provider,
                                    provider_ref, started_at, finished_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
          )
          .bind(
            newId('jit'),
            jobId,
            item.episodeId,
            item.seriesId,
            item.position,
            item.quality,
            item.container,
            item.objectKey,
            timestamp,
          ),
      );
    });

    // One D1 batch == one transaction: either the job and all of its items exist, or nothing does.
    await this.db.batch(statements);
    return (await this.getJob(jobId))!;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(id).first<JobRow>();
    return row ? mapJob(row) : null;
  }

  async requireJob(id: string): Promise<JobRecord> {
    const job = await this.getJob(id);
    if (!job) throw notFound(`Job ${id} not found`);
    return job;
  }

  async listJobs(filter: {
    status?: string;
    seriesId?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: JobListItem[]; total: number }> {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (filter.status) {
      clauses.push('j.status = ?');
      values.push(filter.status);
    }
    if (filter.seriesId) {
      clauses.push('j.series_id = ?');
      values.push(filter.seriesId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM jobs j ${where}`)
      .bind(...values)
      .first<{ total: number }>();

    const rows = await this.db
      .prepare(
        `SELECT j.*, s.title AS series_title,
                (SELECT COALESCE(SUM(ji.bytes), 0) FROM job_items ji WHERE ji.job_id = j.id) AS bytes
         FROM jobs j
         LEFT JOIN series s ON s.id = j.series_id
         ${where}
         ORDER BY j.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...values, filter.limit, filter.offset)
      .all<JobRow & { series_title: string | null; bytes: number }>();

    return {
      items: rows.results.map((row) => ({
        ...mapJob(row),
        seriesTitle: row.series_title,
        bytes: row.bytes ?? 0,
      })),
      total: totalRow?.total ?? 0,
    };
  }

  async updateJob(id: string, patch: JobPatch): Promise<void> {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const push = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.startedAt !== undefined) push('started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) push('finished_at', patch.finishedAt);
    if (patch.totalItems !== undefined) push('total_items', patch.totalItems);
    if (patch.completedItems !== undefined) push('completed_items', patch.completedItems);
    if (patch.failedItems !== undefined) push('failed_items', patch.failedItems);
    if (patch.cancelledItems !== undefined) push('cancelled_items', patch.cancelledItems);
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(nowIso(), id);
    await this.db
      .prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  /**
   * Recompute counters straight from `job_items` and derive the job status.
   * This is the single source of truth for progress: no counter can drift.
   */
  async recomputeJob(id: string): Promise<JobRecord> {
    const job = await this.requireJob(id);
    const counts = await this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
           COALESCE(SUM(CASE WHEN status IN ('pending', 'downloading') THEN 1 ELSE 0 END), 0) AS active
         FROM job_items WHERE job_id = ?`,
      )
      .bind(id)
      .first<{ total: number; completed: number; failed: number; cancelled: number; active: number }>();

    const total = counts?.total ?? 0;
    const completed = counts?.completed ?? 0;
    const failed = counts?.failed ?? 0;
    const cancelled = counts?.cancelled ?? 0;
    const active = counts?.active ?? 0;

    let status: JobStatus;
    let finishedAt: string | null = null;
    if (job.status === 'cancelled') {
      status = 'cancelled';
      finishedAt = job.finishedAt ?? nowIso();
    } else if (active > 0) {
      status = 'running';
    } else if (total === 0) {
      status = 'completed';
      finishedAt = nowIso();
    } else if (completed === total) {
      status = 'completed';
      finishedAt = nowIso();
    } else if (failed > 0 || cancelled > 0) {
      status = 'partial';
      finishedAt = nowIso();
    } else {
      status = 'pending';
    }

    await this.updateJob(id, {
      status,
      totalItems: total,
      completedItems: completed,
      failedItems: failed,
      cancelledItems: cancelled,
      startedAt: job.startedAt ?? (status === 'running' ? nowIso() : null),
      finishedAt,
    });
    return (await this.getJob(id))!;
  }

  async jobDetail(jobId: string): Promise<JobDetail> {
    const job = await this.requireJob(jobId);
    const [items, series] = await Promise.all([this.listJobItems(jobId), this.getSeries(job.seriesId)]);
    return {
      job,
      items,
      series: series
        ? {
            id: series.id,
            title: series.title,
            sourceKey: series.sourceKey,
            sourceUrl: series.sourceUrl,
            posterUrl: series.posterUrl,
          }
        : null,
    };
  }

  // ------------------------------ job items ---------------------------------

  async listJobItems(jobId: string): Promise<JobItemView[]> {
    const rows = await this.db
      .prepare(
        `SELECT ji.*, e.episode_index, e.title AS episode_title, e.source_url AS episode_url
         FROM job_items ji
         JOIN episodes e ON e.id = ji.episode_id
         WHERE ji.job_id = ?
         ORDER BY ji.position ASC`,
      )
      .bind(jobId)
      .all<JobItemViewRow>();
    return rows.results.map(mapJobItemView);
  }

  async getJobItem(id: string): Promise<JobItemRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM job_items WHERE id = ?`).bind(id).first<JobItemRow>();
    return row ? mapJobItem(row) : null;
  }

  async updateJobItem(id: string, patch: JobItemPatch): Promise<void> {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const push = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.progress !== undefined) push('progress', Math.max(0, Math.min(100, Math.round(patch.progress))));
    if (patch.attempts !== undefined) push('attempts', patch.attempts);
    if (patch.bytes !== undefined) push('bytes', patch.bytes);
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.fileId !== undefined) push('file_id', patch.fileId);
    if (patch.provider !== undefined) push('provider', patch.provider);
    if (patch.providerRef !== undefined) push('provider_ref', patch.providerRef);
    if (patch.startedAt !== undefined) push('started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) push('finished_at', patch.finishedAt);
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(nowIso(), id);
    await this.db
      .prepare(`UPDATE job_items SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  /** Items that were handed to a provider but never came back. */
  async listStaleItems(olderThanIso: string, limit: number): Promise<JobItemRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM job_items
         WHERE status = 'downloading' AND updated_at < ?
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .bind(olderThanIso, limit)
      .all<JobItemRow>();
    return rows.results.map(mapJobItem);
  }

  async countItemsByStatus(jobId: string, statuses: JobItemStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => '?').join(', ');
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM job_items WHERE job_id = ? AND status IN (${placeholders})`,
      )
      .bind(jobId, ...statuses)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async listItemsByStatus(jobId: string, statuses: JobItemStatus[]): Promise<JobItemRecord[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = await this.db
      .prepare(
        `SELECT * FROM job_items WHERE job_id = ? AND status IN (${placeholders}) ORDER BY position ASC`,
      )
      .bind(jobId, ...statuses)
      .all<JobItemRow>();
    return rows.results.map(mapJobItem);
  }

  /** Bulk transition every item of a job that is currently in `statuses`. */
  async updateItemsByStatus(
    jobId: string,
    statuses: JobItemStatus[],
    patch: JobItemPatch,
  ): Promise<number> {
    if (statuses.length === 0) return 0;
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const push = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.progress !== undefined) push('progress', patch.progress);
    if (patch.attempts !== undefined) push('attempts', patch.attempts);
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.finishedAt !== undefined) push('finished_at', patch.finishedAt);
    if (fields.length === 0) return 0;
    fields.push('updated_at = ?');
    values.push(nowIso());
    const placeholders = statuses.map(() => '?').join(', ');
    const result = await this.db
      .prepare(
        `UPDATE job_items SET ${fields.join(', ')}
         WHERE job_id = ? AND status IN (${placeholders})`,
      )
      .bind(...values, jobId, ...statuses)
      .run();
    return result.meta.changes ?? 0;
  }

  async listPendingItemIds(jobId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(`SELECT id FROM job_items WHERE job_id = ? AND status = 'pending' ORDER BY position ASC`)
      .bind(jobId)
      .all<{ id: string }>();
    return rows.results.map((row) => row.id);
  }

  // -------------------------------- files -----------------------------------

  async insertFile(input: InsertFileInput): Promise<FileRecord> {
    const id = newId('fil');
    const timestamp = nowIso();
    await this.db
      .prepare(
        `INSERT INTO files (id, job_id, job_item_id, series_id, episode_id, bucket, object_key, filename,
                            content_type, size, etag, checksum_sha256, quality, container, duration_seconds,
                            provider, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.jobId,
        input.jobItemId,
        input.seriesId,
        input.episodeId,
        input.bucket,
        input.objectKey,
        input.filename,
        input.contentType,
        input.size,
        input.etag,
        input.checksumSha256,
        input.quality,
        input.container,
        input.durationSeconds,
        input.provider,
        stringifyJson(input.metadata),
        timestamp,
      )
      .run();
    return (await this.getFile(id))!;
  }

  async getFile(id: string): Promise<FileRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM files WHERE id = ?`).bind(id).first<FileRow>();
    return row ? mapFile(row) : null;
  }

  async listFiles(filter: {
    jobId?: string;
    seriesId?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: FileRecord[]; total: number }> {
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (filter.jobId) {
      clauses.push('job_id = ?');
      values.push(filter.jobId);
    }
    if (filter.seriesId) {
      clauses.push('series_id = ?');
      values.push(filter.seriesId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = await this.db
      .prepare(`SELECT COUNT(*) AS total FROM files ${where}`)
      .bind(...values)
      .first<{ total: number }>();
    const rows = await this.db
      .prepare(`SELECT * FROM files ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...values, filter.limit, filter.offset)
      .all<FileRow>();
    return { items: rows.results.map(mapFile), total: totalRow?.total ?? 0 };
  }

  async deleteFile(id: string): Promise<FileRecord | null> {
    const file = await this.getFile(id);
    if (!file) return null;
    await this.db.prepare(`DELETE FROM files WHERE id = ?`).bind(id).run();
    return file;
  }

  // -------------------------------- events ----------------------------------

  async appendEvent(event: {
    jobId?: string | null;
    jobItemId?: string | null;
    level: JobEventLevel;
    message: string;
    data?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO job_events (job_id, job_item_id, level, message, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.jobId ?? null,
        event.jobItemId ?? null,
        event.level,
        event.message,
        event.data ? stringifyJson(event.data) : null,
        nowIso(),
      )
      .run();
  }

  async listEvents(jobId: string, limit = 200): Promise<JobEventRecord[]> {
    const rows = await this.db
      .prepare(`SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?`)
      .bind(jobId, limit)
      .all<JobEventRow>();
    return rows.results.map(mapJobEvent);
  }
}
