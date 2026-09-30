import type { Env } from '../env';
import { handleQueue } from '../queue/consumer';
import type { QueueMessage } from '../queue/messages';

/**
 * Automatic D1 schema initialization + built-in Edge fallbacks for D1, R2 and Queues.
 *
 * Why this exists:
 *   1. When a real D1 database is bound on Cloudflare, `wrangler deploy` does not
 *      automatically execute `wrangler d1 migrations apply --remote`. `ensureD1Schema()`
 *      runs the idempotent `CREATE TABLE IF NOT EXISTS` statements automatically on
 *      first use so a freshly bound D1 database works immediately.
 *   2. When deployed to Cloudflare Workers without pre-created D1 / R2 / Queue
 *      bindings (for example via Git integration with the default Workers Builds
 *      token, or on the Workers Free plan where Queues is unavailable),
 *      `ensureRuntimeEnv()` provides D1-, R2- and Queue-compatible fallback bindings
 *      backed by isolate memory and Cloudflare's Edge Cache (`caches.default`).
 */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS series (
    id            TEXT PRIMARY KEY,
    source_key    TEXT NOT NULL,
    source_url    TEXT NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    synopsis      TEXT,
    poster_url    TEXT,
    episode_count INTEGER NOT NULL DEFAULT 0,
    metadata      TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_series_updated ON series (updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS episodes (
    id               TEXT PRIMARY KEY,
    series_id        TEXT NOT NULL REFERENCES series (id) ON DELETE CASCADE,
    episode_index    INTEGER NOT NULL,
    title            TEXT NOT NULL,
    source_url       TEXT NOT NULL,
    duration_seconds INTEGER,
    thumbnail_url    TEXT,
    streams          TEXT NOT NULL DEFAULT '[]',
    metadata         TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (series_id, episode_index)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes (series_id, episode_index)`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    series_id        TEXT NOT NULL REFERENCES series (id) ON DELETE CASCADE,
    status           TEXT NOT NULL,
    selection        TEXT NOT NULL,
    options          TEXT NOT NULL,
    total_items      INTEGER NOT NULL DEFAULT 0,
    completed_items  INTEGER NOT NULL DEFAULT 0,
    failed_items     INTEGER NOT NULL DEFAULT 0,
    cancelled_items  INTEGER NOT NULL DEFAULT 0,
    error            TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS job_items (
    id           TEXT PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    episode_id   TEXT NOT NULL REFERENCES episodes (id) ON DELETE CASCADE,
    series_id    TEXT NOT NULL,
    position     INTEGER NOT NULL,
    status       TEXT NOT NULL,
    progress     INTEGER NOT NULL DEFAULT 0,
    attempts     INTEGER NOT NULL DEFAULT 0,
    quality      TEXT NOT NULL,
    container    TEXT NOT NULL,
    object_key   TEXT NOT NULL,
    bytes        INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    file_id      TEXT,
    provider     TEXT,
    provider_ref TEXT,
    started_at   TEXT,
    finished_at  TEXT,
    updated_at   TEXT NOT NULL,
    UNIQUE (job_id, episode_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items (job_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_job_items_status ON job_items (status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS files (
    id               TEXT PRIMARY KEY,
    job_id           TEXT,
    job_item_id      TEXT,
    series_id        TEXT,
    episode_id       TEXT,
    bucket           TEXT NOT NULL,
    object_key       TEXT NOT NULL,
    filename         TEXT NOT NULL,
    content_type     TEXT NOT NULL,
    size             INTEGER NOT NULL DEFAULT 0,
    etag             TEXT,
    checksum_sha256  TEXT,
    quality          TEXT,
    container        TEXT,
    duration_seconds INTEGER,
    provider         TEXT NOT NULL,
    metadata         TEXT NOT NULL DEFAULT '{}',
    created_at       TEXT NOT NULL,
    UNIQUE (bucket, object_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_files_job ON files (job_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS job_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT,
    job_item_id TEXT,
    level       TEXT NOT NULL DEFAULT 'info',
    message     TEXT NOT NULL,
    data        TEXT,
    created_at  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events (job_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_job_events_item ON job_events (job_item_id, id DESC)`,
];

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

const initializedDbs = new WeakMap<object, Promise<void>>();
const wrappedDbs = new WeakMap<D1Database, D1Database>();

/**
 * Ensure all VTGrab tables and indexes exist in `db`.
 * Runs once per `D1Database` instance and is a no-op on `FallbackD1Database`.
 */
export function ensureD1Schema(db: D1Database): Promise<void> {
  if (db instanceof FallbackD1Database) return Promise.resolve();
  const existing = initializedDbs.get(db);
  if (existing) return existing;

  const initPromise = (async () => {
    try {
      await db.batch(SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
    } catch (error) {
      // Allow subsequent calls to retry if a transient D1 error occurred.
      initializedDbs.delete(db);
      throw error;
    }
  })();

  initializedDbs.set(db, initPromise);
  return initPromise;
}

/**
 * Wrap a `D1Database` so that `ensureD1Schema(db)` runs automatically before the
 * first statement or batch is executed.
 */
export function withAutoSchema(db: D1Database): D1Database {
  if (db instanceof FallbackD1Database) return db;
  const cached = wrappedDbs.get(db);
  if (cached) return cached;

  const wrapStmt = (
    stmt: D1PreparedStatement,
  ): D1PreparedStatement & { __raw: D1PreparedStatement } => ({
    __raw: stmt,
    bind(...values: unknown[]) {
      return wrapStmt(stmt.bind(...values));
    },
    async first<T = unknown>(colName?: string) {
      await ensureD1Schema(db);
      return colName !== undefined ? stmt.first<T>(colName) : stmt.first<T>();
    },
    async run<T = Record<string, unknown>>() {
      await ensureD1Schema(db);
      return stmt.run<T>();
    },
    async all<T = Record<string, unknown>>() {
      await ensureD1Schema(db);
      return stmt.all<T>();
    },
    raw: (async <T = unknown[]>(options?: { columnNames?: boolean }) => {
      await ensureD1Schema(db);
      return options ? stmt.raw<T>(options as never) : stmt.raw<T>();
    }) as D1PreparedStatement['raw'],
  });

  const wrapped: D1Database = {
    prepare(query: string) {
      return wrapStmt(db.prepare(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      await ensureD1Schema(db);
      const rawStmts = statements.map(
        (stmt) => (stmt as unknown as { __raw?: D1PreparedStatement }).__raw ?? stmt,
      );
      return db.batch<T>(rawStmts);
    },
    async exec(query: string) {
      await ensureD1Schema(db);
      return db.exec(query);
    },
    withSession(constraintOrBookmark?: string) {
      return db.withSession(constraintOrBookmark);
    },
    async dump() {
      return db.dump();
    },
  };

  wrappedDbs.set(db, wrapped);
  return wrapped;
}

// ---------------------------------------------------------------------------
// Edge Cache helper (persists fallback state across isolates within a PoP)
// ---------------------------------------------------------------------------

const DB_CACHE_URL = 'https://vtgrab-internal.local/__state/db-v1';
const R2_CACHE_PREFIX = 'https://vtgrab-internal.local/__r2/';

function getEdgeCache(): Cache | null {
  try {
    if (typeof caches !== 'undefined' && caches.default) {
      return caches.default;
    }
  } catch {
    // `caches.default` may throw in non-Cloudflare environments.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fallback D1 Database
// ---------------------------------------------------------------------------

interface SeriesRowData {
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

interface EpisodeRowData {
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

interface JobRowData {
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

interface JobItemRowData {
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

interface FileRowData {
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

interface JobEventRowData {
  id: number;
  job_id: string | null;
  job_item_id: string | null;
  level: string;
  message: string;
  data: string | null;
  created_at: string;
}

interface SerializedDbState {
  nextEventId: number;
  series: SeriesRowData[];
  episodes: EpisodeRowData[];
  jobs: JobRowData[];
  jobItems: JobItemRowData[];
  files: FileRowData[];
  jobEvents: JobEventRowData[];
}

class FallbackPreparedStatement {
  constructor(
    private readonly db: FallbackD1Database,
    public readonly sql: string,
    public readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new FallbackPreparedStatement(this.db, this.sql, values) as unknown as D1PreparedStatement;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const result = await this.db.execute<Record<string, unknown>>(this.sql, this.params);
    const row = result.results[0] ?? null;
    if (!row) return null;
    if (colName !== undefined) return (row[colName] as T) ?? null;
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.execute<T>(this.sql, this.params);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.execute<T>(this.sql, this.params);
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const result = await this.db.execute<Record<string, unknown>>(this.sql, this.params);
    const rows = result.results;
    if (rows.length === 0) return [];
    const keys = Object.keys(rows[0]);
    const values = rows.map((row) => keys.map((key) => row[key])) as unknown as T[];
    if (options?.columnNames) {
      return [keys as unknown as T, ...values];
    }
    return values;
  }
}

export class FallbackD1Database implements D1Database {
  private hydrated = false;
  private nextEventId = 1;
  private readonly series = new Map<string, SeriesRowData>();
  private readonly episodes = new Map<string, EpisodeRowData>();
  private readonly jobs = new Map<string, JobRowData>();
  private readonly jobItems = new Map<string, JobItemRowData>();
  private readonly files = new Map<string, FileRowData>();
  private jobEvents: JobEventRowData[] = [];

  prepare(query: string): D1PreparedStatement {
    return new FallbackPreparedStatement(this, query) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    await this.ensureHydrated();
    const results: D1Result<T>[] = [];
    for (const stmt of statements) {
      const fallbackStmt = stmt as unknown as FallbackPreparedStatement;
      results.push(await this.executeInternal<T>(fallbackStmt.sql, fallbackStmt.params, false));
    }
    await this.persistToCache();
    return results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    await this.ensureHydrated();
    const statements = query
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const sql of statements) {
      await this.executeInternal(sql, [], false);
    }
    await this.persistToCache();
    return { count: statements.length, duration: 0 };
  }

  withSession(_constraintOrBookmark?: string): D1DatabaseSession {
    return this as unknown as D1DatabaseSession;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const cache = getEdgeCache();
    if (!cache) return;
    try {
      const response = await cache.match(DB_CACHE_URL);
      if (!response) return;
      const state = (await response.json()) as SerializedDbState;
      if (this.series.size === 0 && state.series) {
        for (const row of state.series) this.series.set(row.id, row);
      }
      if (this.episodes.size === 0 && state.episodes) {
        for (const row of state.episodes) this.episodes.set(row.id, row);
      }
      if (this.jobs.size === 0 && state.jobs) {
        for (const row of state.jobs) this.jobs.set(row.id, row);
      }
      if (this.jobItems.size === 0 && state.jobItems) {
        for (const row of state.jobItems) this.jobItems.set(row.id, row);
      }
      if (this.files.size === 0 && state.files) {
        for (const row of state.files) this.files.set(row.id, row);
      }
      if (this.jobEvents.length === 0 && state.jobEvents) {
        this.jobEvents = state.jobEvents;
        this.nextEventId = Math.max(this.nextEventId, state.nextEventId ?? 1);
      }
    } catch {
      // Ignore cache hydration failures and continue with in-memory state.
    }
  }

  private async persistToCache(): Promise<void> {
    const cache = getEdgeCache();
    if (!cache) return;
    try {
      const payload: SerializedDbState = {
        nextEventId: this.nextEventId,
        series: [...this.series.values()],
        episodes: [...this.episodes.values()],
        jobs: [...this.jobs.values()],
        jobItems: [...this.jobItems.values()],
        files: [...this.files.values()],
        jobEvents: this.jobEvents.slice(-1000),
      };
      await cache.put(
        DB_CACHE_URL,
        new Response(JSON.stringify(payload), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=86400',
          },
        }),
      );
    } catch {
      // Ignore cache write errors.
    }
  }

  async execute<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<D1Result<T>> {
    await this.ensureHydrated();
    return this.executeInternal<T>(sql, params, true);
  }

  private async executeInternal<T = Record<string, unknown>>(
    sql: string,
    params: unknown[],
    persist: boolean,
  ): Promise<D1Result<T>> {
    const norm = sql.replace(/\s+/g, ' ').trim();
    let rows: unknown[] = [];
    let changes = 0;
    let mutated = false;

    // 1. Health check & DDL
    if (/^SELECT 1 AS ok$/i.test(norm)) {
      rows = [{ ok: 1 }];
    } else if (/^CREATE (TABLE|INDEX)/i.test(norm)) {
      rows = [];
    }
    // 2. series
    else if (/^INSERT INTO series /i.test(norm)) {
      const [
        id,
        source_key,
        source_url,
        canonical_url,
        title,
        synopsis,
        poster_url,
        metadata,
        created_at,
        updated_at,
      ] = params as [string, string, string, string, string, string | null, string | null, string, string, string];
      this.series.set(id, {
        id,
        source_key,
        source_url,
        canonical_url,
        title,
        synopsis: synopsis ?? null,
        poster_url: poster_url ?? null,
        episode_count: 0,
        metadata,
        created_at,
        updated_at,
      });
      changes = 1;
      mutated = true;
    } else if (/^UPDATE series SET source_key = \?/i.test(norm)) {
      const [source_key, source_url, title, synopsis, poster_url, metadata, updated_at, id] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
        string,
      ];
      const existing = this.series.get(id);
      if (existing) {
        Object.assign(existing, {
          source_key,
          source_url,
          title,
          synopsis: synopsis ?? null,
          poster_url: poster_url ?? null,
          metadata,
          updated_at,
        });
        changes = 1;
        mutated = true;
      }
    } else if (/^UPDATE series SET episode_count = \?, updated_at = \? WHERE id = \?$/i.test(norm)) {
      const [episode_count, updated_at, id] = params as [number, string, string];
      const existing = this.series.get(id);
      if (existing) {
        existing.episode_count = Number(episode_count);
        existing.updated_at = updated_at;
        changes = 1;
        mutated = true;
      }
    } else if (/^SELECT \* FROM series WHERE id = \?$/i.test(norm)) {
      const found = this.series.get(String(params[0]));
      if (found) rows = [{ ...found }];
    } else if (/^SELECT \* FROM series WHERE canonical_url = \?$/i.test(norm)) {
      const target = String(params[0]);
      for (const row of this.series.values()) {
        if (row.canonical_url === target) {
          rows = [{ ...row }];
          break;
        }
      }
    } else if (/^SELECT \* FROM series WHERE source_url = \?$/i.test(norm)) {
      const target = String(params[0]);
      for (const row of this.series.values()) {
        if (row.source_url === target) {
          rows = [{ ...row }];
          break;
        }
      }
    } else if (/^SELECT COUNT\(\*\) AS total FROM series/i.test(norm)) {
      const hasLike = /WHERE title LIKE \?/i.test(norm);
      const needle = hasLike ? String(params[0]).replace(/^%|%$/g, '').toLowerCase() : '';
      let total = 0;
      for (const row of this.series.values()) {
        if (!hasLike || row.title.toLowerCase().includes(needle)) total += 1;
      }
      rows = [{ total }];
    } else if (/^SELECT \* FROM series/i.test(norm)) {
      const hasLike = /WHERE title LIKE \?/i.test(norm);
      const needle = hasLike ? String(params[0]).replace(/^%|%$/g, '').toLowerCase() : '';
      const limit = Number(params[hasLike ? 1 : 0] ?? 20);
      const offset = Number(params[hasLike ? 2 : 1] ?? 0);
      const filtered = [...this.series.values()]
        .filter((row) => !hasLike || row.title.toLowerCase().includes(needle))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      rows = filtered.slice(offset, offset + limit).map((row) => ({ ...row }));
    } else if (/^DELETE FROM series WHERE id = \?$/i.test(norm)) {
      const id = String(params[0]);
      if (this.series.delete(id)) {
        changes = 1;
        mutated = true;
        for (const [epId, ep] of this.episodes.entries()) {
          if (ep.series_id === id) this.episodes.delete(epId);
        }
        for (const [jobId, job] of this.jobs.entries()) {
          if (job.series_id === id) this.jobs.delete(jobId);
        }
        for (const [itemId, item] of this.jobItems.entries()) {
          if (item.series_id === id) this.jobItems.delete(itemId);
        }
      }
    }
    // 3. episodes
    else if (/^SELECT id, episode_index FROM episodes WHERE series_id = \?$/i.test(norm)) {
      const seriesId = String(params[0]);
      rows = [...this.episodes.values()]
        .filter((ep) => ep.series_id === seriesId)
        .map((ep) => ({ id: ep.id, episode_index: ep.episode_index }));
    } else if (/^UPDATE episodes SET title = \?/i.test(norm)) {
      const [title, source_url, duration_seconds, thumbnail_url, streams, metadata, updated_at, id] = params as [
        string,
        string,
        number | null,
        string | null,
        string,
        string,
        string,
        string,
      ];
      const existing = this.episodes.get(id);
      if (existing) {
        Object.assign(existing, {
          title,
          source_url,
          duration_seconds: duration_seconds ?? null,
          thumbnail_url: thumbnail_url ?? null,
          streams,
          metadata,
          updated_at,
        });
        changes = 1;
        mutated = true;
      }
    } else if (/^INSERT INTO episodes /i.test(norm)) {
      const [
        id,
        series_id,
        episode_index,
        title,
        source_url,
        duration_seconds,
        thumbnail_url,
        streams,
        metadata,
        created_at,
        updated_at,
      ] = params as [
        string,
        string,
        number,
        string,
        string,
        number | null,
        string | null,
        string,
        string,
        string,
        string,
      ];
      this.episodes.set(id, {
        id,
        series_id,
        episode_index: Number(episode_index),
        title,
        source_url,
        duration_seconds: duration_seconds ?? null,
        thumbnail_url: thumbnail_url ?? null,
        streams,
        metadata,
        created_at,
        updated_at,
      });
      changes = 1;
      mutated = true;
    } else if (/^DELETE FROM episodes WHERE series_id = \? AND id NOT IN/i.test(norm)) {
      const seriesId = String(params[0]);
      const keep = new Set(params.slice(1).map(String));
      for (const [id, ep] of this.episodes.entries()) {
        if (ep.series_id === seriesId && !keep.has(id)) {
          this.episodes.delete(id);
          changes += 1;
          mutated = true;
        }
      }
    } else if (/^DELETE FROM episodes WHERE series_id = \?$/i.test(norm)) {
      const seriesId = String(params[0]);
      for (const [id, ep] of this.episodes.entries()) {
        if (ep.series_id === seriesId) {
          this.episodes.delete(id);
          changes += 1;
          mutated = true;
        }
      }
    } else if (/^SELECT \* FROM episodes WHERE series_id = \? ORDER BY episode_index ASC$/i.test(norm)) {
      const seriesId = String(params[0]);
      rows = [...this.episodes.values()]
        .filter((ep) => ep.series_id === seriesId)
        .sort((a, b) => a.episode_index - b.episode_index)
        .map((ep) => ({ ...ep }));
    } else if (/^SELECT \* FROM episodes WHERE series_id = \? AND id IN/i.test(norm)) {
      const seriesId = String(params[0]);
      const wanted = new Set(params.slice(1).map(String));
      rows = [...this.episodes.values()]
        .filter((ep) => ep.series_id === seriesId && wanted.has(ep.id))
        .sort((a, b) => a.episode_index - b.episode_index)
        .map((ep) => ({ ...ep }));
    } else if (/^SELECT \* FROM episodes WHERE id = \?$/i.test(norm)) {
      const found = this.episodes.get(String(params[0]));
      if (found) rows = [{ ...found }];
    }
    // 4. jobs
    else if (/^INSERT INTO jobs /i.test(norm)) {
      const [id, series_id, selection, options, total_items, created_at, updated_at] = params as [
        string,
        string,
        string,
        string,
        number,
        string,
        string,
      ];
      this.jobs.set(id, {
        id,
        series_id,
        status: 'pending',
        selection,
        options,
        total_items: Number(total_items),
        completed_items: 0,
        failed_items: 0,
        cancelled_items: 0,
        error: null,
        created_at,
        updated_at,
        started_at: null,
        finished_at: null,
      });
      changes = 1;
      mutated = true;
    } else if (/^SELECT \* FROM jobs WHERE id = \?$/i.test(norm)) {
      const found = this.jobs.get(String(params[0]));
      if (found) rows = [{ ...found }];
    } else if (/^SELECT COUNT\(\*\) AS total FROM jobs j/i.test(norm)) {
      const filtered = this.filterJobs(norm, params, false);
      rows = [{ total: filtered.length }];
    } else if (/^SELECT j\.\*, s\.title AS series_title/i.test(norm)) {
      const limit = Number(params[params.length - 2] ?? 30);
      const offset = Number(params[params.length - 1] ?? 0);
      const filtered = this.filterJobs(norm, params.slice(0, -2), true);
      rows = filtered.slice(offset, offset + limit).map((job) => {
        const series = this.series.get(job.series_id);
        let bytes = 0;
        for (const item of this.jobItems.values()) {
          if (item.job_id === job.id) bytes += item.bytes || 0;
        }
        return {
          ...job,
          series_title: series?.title ?? null,
          bytes,
        };
      });
    } else if (/^UPDATE jobs SET /i.test(norm)) {
      const match = /^UPDATE jobs SET (.+) WHERE id = \?$/i.exec(norm);
      if (match) {
        const id = String(params[params.length - 1]);
        const existing = this.jobs.get(id);
        if (existing) {
          this.applyColumns(existing as unknown as Record<string, unknown>, match[1], params.slice(0, -1));
          changes = 1;
          mutated = true;
        }
      }
    }
    // 5. job_items
    else if (/^SELECT COUNT\(\*\) AS total, COALESCE\(SUM\(CASE WHEN status = 'completed'/i.test(norm)) {
      const jobId = String(params[0]);
      let total = 0;
      let completed = 0;
      let failed = 0;
      let cancelled = 0;
      let active = 0;
      for (const item of this.jobItems.values()) {
        if (item.job_id !== jobId) continue;
        total += 1;
        if (item.status === 'completed') completed += 1;
        else if (item.status === 'failed') failed += 1;
        else if (item.status === 'cancelled') cancelled += 1;
        else if (item.status === 'pending' || item.status === 'downloading') active += 1;
      }
      rows = [{ total, completed, failed, cancelled, active }];
    } else if (/^INSERT INTO job_items /i.test(norm)) {
      if (params.length === 9) {
        // Repository.createJob
        const [id, job_id, episode_id, series_id, position, quality, container, object_key, updated_at] = params as [
          string,
          string,
          string,
          string,
          number,
          string,
          string,
          string,
          string,
        ];
        this.jobItems.set(id, {
          id,
          job_id,
          episode_id,
          series_id,
          position: Number(position),
          status: 'pending',
          progress: 0,
          attempts: 0,
          quality,
          container,
          object_key,
          bytes: 0,
          error: null,
          file_id: null,
          provider: null,
          provider_ref: null,
          started_at: null,
          finished_at: null,
          updated_at,
        });
      } else {
        // seedJob helper format
        const [id, job_id, episode_id, series_id, position, status, attempts, object_key, updated_at] = params as [
          string,
          string,
          string,
          string,
          number,
          string,
          number,
          string,
          string,
        ];
        this.jobItems.set(id, {
          id,
          job_id,
          episode_id,
          series_id,
          position: Number(position),
          status,
          progress: 0,
          attempts: Number(attempts),
          quality: '720p',
          container: 'mp4',
          object_key,
          bytes: 0,
          error: null,
          file_id: null,
          provider: null,
          provider_ref: null,
          started_at: null,
          finished_at: null,
          updated_at,
        });
      }
      changes = 1;
      mutated = true;
    } else if (/^SELECT ji\.\*, e\.episode_index/i.test(norm)) {
      const jobId = String(params[0]);
      rows = [...this.jobItems.values()]
        .filter((item) => item.job_id === jobId)
        .sort((a, b) => a.position - b.position)
        .flatMap((item) => {
          const ep = this.episodes.get(item.episode_id);
          if (!ep) return [];
          return [
            {
              ...item,
              episode_index: ep.episode_index,
              episode_title: ep.title,
              episode_url: ep.source_url,
            },
          ];
        });
    } else if (/^SELECT \* FROM job_items WHERE id = \?$/i.test(norm)) {
      const found = this.jobItems.get(String(params[0]));
      if (found) rows = [{ ...found }];
    } else if (/^UPDATE job_items SET .+ WHERE id = \?$/i.test(norm)) {
      const match = /^UPDATE job_items SET (.+) WHERE id = \?$/i.exec(norm);
      if (match) {
        const id = String(params[params.length - 1]);
        const existing = this.jobItems.get(id);
        if (existing) {
          this.applyColumns(existing as unknown as Record<string, unknown>, match[1], params.slice(0, -1));
          changes = 1;
          mutated = true;
        }
      }
    } else if (/^SELECT \* FROM job_items WHERE status = 'downloading' AND updated_at < \?/i.test(norm)) {
      const cutoff = String(params[0]);
      const limit = Number(params[1] ?? 50);
      rows = [...this.jobItems.values()]
        .filter((item) => item.status === 'downloading' && item.updated_at < cutoff)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at))
        .slice(0, limit)
        .map((item) => ({ ...item }));
    } else if (/^SELECT COUNT\(\*\) AS total FROM job_items WHERE job_id = \?$/i.test(norm)) {
      const jobId = String(params[0]);
      let total = 0;
      for (const item of this.jobItems.values()) {
        if (item.job_id === jobId) total += 1;
      }
      rows = [{ total }];
    } else if (/^SELECT COUNT\(\*\) AS total FROM job_items WHERE job_id = \? AND status IN/i.test(norm)) {
      const jobId = String(params[0]);
      const statuses = new Set(params.slice(1).map(String));
      let total = 0;
      for (const item of this.jobItems.values()) {
        if (item.job_id === jobId && statuses.has(item.status)) total += 1;
      }
      rows = [{ total }];
    } else if (/^SELECT \* FROM job_items WHERE job_id = \? AND status IN/i.test(norm)) {
      const jobId = String(params[0]);
      const statuses = new Set(params.slice(1).map(String));
      rows = [...this.jobItems.values()]
        .filter((item) => item.job_id === jobId && statuses.has(item.status))
        .sort((a, b) => a.position - b.position)
        .map((item) => ({ ...item }));
    } else if (/^UPDATE job_items SET .+ WHERE job_id = \? AND status IN/i.test(norm)) {
      const match = /^UPDATE job_items SET (.+) WHERE job_id = \? AND status IN \((.+)\)$/i.exec(norm);
      if (match) {
        const setClause = match[1];
        const colCount = setClause.split(',').length;
        const setParams = params.slice(0, colCount);
        const jobId = String(params[colCount]);
        const statuses = new Set(params.slice(colCount + 1).map(String));
        for (const item of this.jobItems.values()) {
          if (item.job_id === jobId && statuses.has(item.status)) {
            this.applyColumns(item as unknown as Record<string, unknown>, setClause, setParams);
            changes += 1;
            mutated = true;
          }
        }
      }
    } else if (/^SELECT id FROM job_items WHERE job_id = \? AND status = 'pending'/i.test(norm)) {
      const jobId = String(params[0]);
      rows = [...this.jobItems.values()]
        .filter((item) => item.job_id === jobId && item.status === 'pending')
        .sort((a, b) => a.position - b.position)
        .map((item) => ({ id: item.id }));
    }
    // 6. files
    else if (/^INSERT INTO files /i.test(norm)) {
      const [
        id,
        job_id,
        job_item_id,
        series_id,
        episode_id,
        bucket,
        object_key,
        filename,
        content_type,
        size,
        etag,
        checksum_sha256,
        quality,
        container,
        duration_seconds,
        provider,
        metadata,
        created_at,
      ] = params as [
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string,
        string,
        string,
        string,
        number,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
        string,
        string,
        string,
      ];
      // Upsert on (bucket, object_key)
      let targetId = id;
      for (const [existingId, existing] of this.files.entries()) {
        if (existing.bucket === bucket && existing.object_key === object_key) {
          targetId = existingId;
          break;
        }
      }
      this.files.set(targetId, {
        id: targetId,
        job_id: job_id ?? null,
        job_item_id: job_item_id ?? null,
        series_id: series_id ?? null,
        episode_id: episode_id ?? null,
        bucket,
        object_key,
        filename,
        content_type,
        size: Number(size),
        etag: etag ?? null,
        checksum_sha256: checksum_sha256 ?? null,
        quality: quality ?? null,
        container: container ?? null,
        duration_seconds: duration_seconds ?? null,
        provider,
        metadata,
        created_at,
      });
      changes = 1;
      mutated = true;
    } else if (/^SELECT \* FROM files WHERE id = \?$/i.test(norm)) {
      const found = this.files.get(String(params[0]));
      if (found) rows = [{ ...found }];
    } else if (/^SELECT \* FROM files WHERE bucket = \? AND object_key = \?$/i.test(norm)) {
      const bucket = String(params[0]);
      const objectKey = String(params[1]);
      for (const file of this.files.values()) {
        if (file.bucket === bucket && file.object_key === objectKey) {
          rows = [{ ...file }];
          break;
        }
      }
    } else if (/^SELECT COUNT\(\*\) AS total FROM files/i.test(norm)) {
      const filtered = this.filterFiles(norm, params, false);
      rows = [{ total: filtered.length }];
    } else if (/^SELECT \* FROM files/i.test(norm)) {
      const limit = Number(params[params.length - 2] ?? 30);
      const offset = Number(params[params.length - 1] ?? 0);
      const filtered = this.filterFiles(norm, params.slice(0, -2), true);
      rows = filtered.slice(offset, offset + limit).map((row) => ({ ...row }));
    } else if (/^DELETE FROM files WHERE id = \?$/i.test(norm)) {
      const id = String(params[0]);
      if (this.files.delete(id)) {
        changes = 1;
        mutated = true;
      }
    }
    // 7. job_events
    else if (/^INSERT INTO job_events /i.test(norm)) {
      const [job_id, job_item_id, level, message, data, created_at] = params as [
        string | null,
        string | null,
        string,
        string,
        string | null,
        string,
      ];
      const id = this.nextEventId++;
      this.jobEvents.push({
        id,
        job_id: job_id ?? null,
        job_item_id: job_item_id ?? null,
        level,
        message,
        data: data ?? null,
        created_at,
      });
      changes = 1;
      mutated = true;
    } else if (/^SELECT \* FROM job_events WHERE job_id = \? ORDER BY id DESC LIMIT \?$/i.test(norm)) {
      const jobId = String(params[0]);
      const limit = Number(params[1] ?? 200);
      rows = this.jobEvents
        .filter((ev) => ev.job_id === jobId)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map((ev) => ({ ...ev }));
    }

    if (mutated && persist) {
      await this.persistToCache();
    }

    return {
      results: rows as T[],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: rows.length,
        rows_written: changes,
        last_row_id: 0,
        changed_db: mutated,
        changes,
      },
    };
  }

  private applyColumns(target: Record<string, unknown>, setClause: string, values: unknown[]): void {
    const assignments = setClause.split(',').map((part) => part.trim());
    assignments.forEach((assignment, index) => {
      const col = assignment.split('=')[0].trim();
      target[col] = values[index] ?? null;
    });
  }

  private filterJobs(norm: string, filterParams: unknown[], sort: boolean): JobRowData[] {
    let idx = 0;
    const statusFilter = /j\.status = \?/.test(norm) ? String(filterParams[idx++]) : null;
    const seriesFilter = /j\.series_id = \?/.test(norm) ? String(filterParams[idx++]) : null;
    const list = [...this.jobs.values()].filter((job) => {
      if (statusFilter && job.status !== statusFilter) return false;
      if (seriesFilter && job.series_id !== seriesFilter) return false;
      return true;
    });
    if (sort) list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return list;
  }

  private filterFiles(norm: string, filterParams: unknown[], sort: boolean): FileRowData[] {
    let idx = 0;
    const jobFilter = /job_id = \?/.test(norm) ? String(filterParams[idx++]) : null;
    const seriesFilter = /series_id = \?/.test(norm) ? String(filterParams[idx++]) : null;
    const list = [...this.files.values()].filter((file) => {
      if (jobFilter && file.job_id !== jobFilter) return false;
      if (seriesFilter && file.series_id !== seriesFilter) return false;
      return true;
    });
    if (sort) list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return list;
  }
}

// ---------------------------------------------------------------------------
// Fallback R2 Bucket
// ---------------------------------------------------------------------------

interface StoredR2Entry {
  key: string;
  bytes: Uint8Array;
  etag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

async function toBytes(
  value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): Promise<Uint8Array> {
  if (value === null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (value instanceof ReadableStream) {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunk && chunk.byteLength > 0) {
          chunks.push(chunk);
          total += chunk.byteLength;
        }
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }
  return new Uint8Array(0);
}

function makeR2Object(entry: StoredR2Entry): R2Object {
  return {
    key: entry.key,
    version: 'v1',
    size: entry.bytes.byteLength,
    etag: entry.etag,
    httpEtag: `"${entry.etag}"`,
    checksums: { toJSON: () => ({}) },
    uploaded: entry.uploaded,
    httpMetadata: entry.httpMetadata,
    customMetadata: entry.customMetadata,
    storageClass: 'Standard',
    writeHttpMetadata(headers: Headers) {
      if (entry.httpMetadata?.contentType) headers.set('content-type', entry.httpMetadata.contentType);
    },
  } as unknown as R2Object;
}

function makeR2ObjectBody(entry: StoredR2Entry, slice: Uint8Array, range?: R2Range): R2ObjectBody {
  const base = makeR2Object(entry);
  const makeStream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(slice);
        controller.close();
      },
    });
  return {
    ...base,
    range,
    get body() {
      return makeStream();
    },
    bodyUsed: false,
    async arrayBuffer() {
      return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer;
    },
    async bytes() {
      return new Uint8Array(slice);
    },
    async text() {
      return new TextDecoder().decode(slice);
    },
    async json<T>() {
      return JSON.parse(new TextDecoder().decode(slice)) as T;
    },
    async blob() {
      return new Blob([slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer]);
    },
  } as unknown as R2ObjectBody;
}

export class FallbackR2Bucket implements R2Bucket {
  private readonly objects = new Map<string, StoredR2Entry>();

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    const bytes = await toBytes(value);
    const etag = `etag-${bytes.byteLength}-${Date.now().toString(36)}`;
    const httpMetadata =
      options?.httpMetadata && !(options.httpMetadata instanceof Headers)
        ? options.httpMetadata
        : undefined;
    const entry: StoredR2Entry = {
      key,
      bytes,
      etag,
      uploaded: new Date(),
      httpMetadata,
      customMetadata: options?.customMetadata,
    };
    this.objects.set(key, entry);
    await this.persistEntryToCache(entry);
    return makeR2Object(entry);
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const entry = await this.loadEntry(key);
    if (!entry) return null;

    let slice = entry.bytes;
    let resolvedRange: R2Range | undefined;
    const range = options?.range && !(options.range instanceof Headers) ? options.range : undefined;
    if (range) {
      if ('suffix' in range && range.suffix !== undefined) {
        const len = Math.min(entry.bytes.byteLength, range.suffix);
        const start = Math.max(0, entry.bytes.byteLength - len);
        slice = entry.bytes.subarray(start, start + len);
        resolvedRange = { offset: start, length: len };
      } else {
        const offsetRange = range as { offset?: number; length?: number };
        const start = offsetRange.offset ?? 0;
        const len =
          offsetRange.length !== undefined
            ? Math.min(offsetRange.length, Math.max(0, entry.bytes.byteLength - start))
            : Math.max(0, entry.bytes.byteLength - start);
        slice = entry.bytes.subarray(start, start + len);
        resolvedRange = { offset: start, length: len };
      }
    }
    return makeR2ObjectBody(entry, slice, resolvedRange);
  }

  async head(key: string): Promise<R2Object | null> {
    const entry = await this.loadEntry(key);
    return entry ? makeR2Object(entry) : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    const cache = getEdgeCache();
    for (const key of list) {
      this.objects.delete(key);
      if (cache) {
        try {
          await cache.delete(this.cacheUrl(key));
        } catch {
          // Ignore cache delete errors.
        }
      }
    }
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const objects = [...this.objects.values()]
      .filter((entry) => entry.key.startsWith(prefix))
      .slice(0, limit)
      .map(makeR2Object);
    return {
      objects,
      truncated: false,
      delimitedPrefixes: [],
    };
  }

  async createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload> {
    const parts = new Map<number, Uint8Array>();
    const uploadId = `mp-${Date.now().toString(36)}`;
    const bucket = this;

    return {
      key,
      uploadId,
      async uploadPart(
        partNumber: number,
        value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
      ): Promise<R2UploadedPart> {
        const bytes = await toBytes(value);
        parts.set(partNumber, bytes);
        return { partNumber, etag: `part-${partNumber}-${bytes.byteLength}` };
      },
      async abort(): Promise<void> {
        parts.clear();
      },
      async complete(uploadedParts: R2UploadedPart[]): Promise<R2Object> {
        const ordered = [...uploadedParts].sort((a, b) => a.partNumber - b.partNumber);
        let total = 0;
        const chunks: Uint8Array[] = [];
        for (const part of ordered) {
          const chunk = parts.get(part.partNumber);
          if (chunk) {
            chunks.push(chunk);
            total += chunk.byteLength;
          }
        }
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.byteLength;
        }
        parts.clear();
        return bucket.put(key, combined, {
          httpMetadata: options?.httpMetadata,
          customMetadata: options?.customMetadata,
        });
      },
    };
  }

  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber) => ({ partNumber, etag: `part-${partNumber}` }),
      abort: async () => {},
      complete: async () => this.put(key, new Uint8Array(0)),
    };
  }

  private cacheUrl(key: string): string {
    return `${R2_CACHE_PREFIX}${encodeURIComponent(key)}`;
  }

  private async persistEntryToCache(entry: StoredR2Entry): Promise<void> {
    const cache = getEdgeCache();
    if (!cache) return;
    try {
      const headers = new Headers({
        'content-type': entry.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
        'x-vtgrab-etag': entry.etag,
        'x-vtgrab-uploaded': entry.uploaded.toISOString(),
      });
      if (entry.customMetadata) {
        headers.set('x-vtgrab-meta', JSON.stringify(entry.customMetadata));
      }
      await cache.put(
        this.cacheUrl(entry.key),
        new Response(entry.bytes as unknown as BodyInit, { headers }),
      );
    } catch {
      // Ignore cache write errors.
    }
  }

  private async loadEntry(key: string): Promise<StoredR2Entry | null> {
    const inMemory = this.objects.get(key);
    if (inMemory) return inMemory;
    const cache = getEdgeCache();
    if (!cache) return null;
    try {
      const response = await cache.match(this.cacheUrl(key));
      if (!response) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const etag = response.headers.get('x-vtgrab-etag') ?? `etag-${bytes.byteLength}`;
      const uploadedRaw = response.headers.get('x-vtgrab-uploaded');
      const metaRaw = response.headers.get('x-vtgrab-meta');
      const entry: StoredR2Entry = {
        key,
        bytes,
        etag,
        uploaded: uploadedRaw ? new Date(uploadedRaw) : new Date(),
        httpMetadata: { contentType },
        customMetadata: metaRaw ? (JSON.parse(metaRaw) as Record<string, string>) : undefined,
      };
      this.objects.set(key, entry);
      return entry;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback Queue
// ---------------------------------------------------------------------------

interface PendingQueueMessage {
  id: string;
  body: QueueMessage;
  attempts: number;
}

export class FallbackQueue {
  private readonly pending: PendingQueueMessage[] = [];
  private draining: Promise<void> | null = null;
  private envRef: Env | null = null;
  private ctxRef: WaitUntilContext | undefined;

  bindContext(env: Env, ctx?: WaitUntilContext): void {
    this.envRef = env;
    if (ctx) this.ctxRef = ctx;
  }

  async send(message: QueueMessage, _options?: QueueSendOptions): Promise<void> {
    this.pending.push({
      id: `qmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      body: message,
      attempts: 1,
    });
    this.scheduleDrain();
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<QueueMessage>>,
    _options?: QueueSendBatchOptions,
  ): Promise<void> {
    for (const entry of messages) {
      this.pending.push({
        id: `qmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        body: entry.body,
        attempts: 1,
      });
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.draining || !this.envRef) return;
    const env = this.envRef;

    this.draining = (async () => {
      // Yield briefly so `POST /api/jobs` returns the initial `pending` state first,
      // matching real Cloudflare Queues behavior before background execution completes.
      await new Promise((resolve) => setTimeout(resolve, 15));

      while (this.pending.length > 0) {
        const chunk = this.pending.splice(0, 10);
        const retryItems: PendingQueueMessage[] = [];

        const batch = {
          queue: 'vtgrab-jobs-fallback',
          messages: chunk.map((item) => ({
            id: item.id,
            timestamp: new Date(),
            body: item.body,
            attempts: item.attempts,
            ack() {},
            retry() {
              if (item.attempts < 3) {
                retryItems.push({ ...item, attempts: item.attempts + 1 });
              }
            },
          })),
          ackAll() {},
          retryAll() {},
        } as unknown as MessageBatch<QueueMessage>;

        await handleQueue(batch, env);

        if (retryItems.length > 0) {
          this.pending.push(...retryItems);
        }
      }
    })().finally(() => {
      this.draining = null;
      if (this.pending.length > 0) {
        this.scheduleDrain();
      }
    });

    if (this.ctxRef && typeof this.ctxRef.waitUntil === 'function') {
      try {
        this.ctxRef.waitUntil(this.draining);
      } catch {
        // Ignore if ExecutionContext is no longer active.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton fallback instances per isolate
// ---------------------------------------------------------------------------

const fallbackDb = new FallbackD1Database();
const fallbackBucket = new FallbackR2Bucket();
const fallbackQueue = new FallbackQueue();
let lastSeenOrigin = '';

/**
 * Populate any missing Cloudflare bindings (`DB`, `FILES`, `JOB_QUEUE`) with
 * built-in Edge fallbacks and infer `PUBLIC_BASE_URL` when unset.
 */
export function ensureRuntimeEnv(env: Env, ctx?: WaitUntilContext, requestUrl?: string): Env {
  if (requestUrl) {
    try {
      lastSeenOrigin = new URL(requestUrl).origin;
    } catch {
      // Ignore malformed request URLs.
    }
  }

  if (!env.DB) {
    env.DB = fallbackDb;
  }
  if (!env.FILES) {
    env.FILES = fallbackBucket;
  }
  if (!env.JOB_QUEUE) {
    env.JOB_QUEUE = fallbackQueue as unknown as Queue<QueueMessage>;
  }
  if (env.JOB_QUEUE instanceof FallbackQueue) {
    env.JOB_QUEUE.bindContext(env, ctx);
  }
  if (!env.PUBLIC_BASE_URL && lastSeenOrigin) {
    env.PUBLIC_BASE_URL = lastSeenOrigin;
  }
  if (!env.ENVIRONMENT) {
    env.ENVIRONMENT = 'production';
  }
  if (!env.DEFAULT_QUALITY) {
    env.DEFAULT_QUALITY = '1080p';
  }
  if (!env.DEFAULT_CONTAINER) {
    env.DEFAULT_CONTAINER = 'mp4';
  }
  return env;
}
