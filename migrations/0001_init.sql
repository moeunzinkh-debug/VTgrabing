-- VTGrab initial schema (D1 / SQLite)
-- Applied with: npx wrangler d1 migrations apply vtgrab-db --local|--remote

CREATE TABLE IF NOT EXISTS series (
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
);

CREATE INDEX IF NOT EXISTS idx_series_updated ON series (updated_at DESC);

CREATE TABLE IF NOT EXISTS episodes (
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
);

CREATE INDEX IF NOT EXISTS idx_episodes_series ON episodes (series_id, episode_index);

CREATE TABLE IF NOT EXISTS jobs (
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
);

CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, created_at DESC);

CREATE TABLE IF NOT EXISTS job_items (
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
);

CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items (job_id, position);
CREATE INDEX IF NOT EXISTS idx_job_items_status ON job_items (status, updated_at);

CREATE TABLE IF NOT EXISTS files (
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
);

CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_job ON files (job_id, created_at);
