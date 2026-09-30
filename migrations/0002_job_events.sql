-- Job audit log: every state transition of a job / job item is appended here and
-- surfaced by GET /api/jobs/:id/events and the frontend "Activity" panel.

CREATE TABLE IF NOT EXISTS job_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT,
  job_item_id TEXT,
  level       TEXT NOT NULL DEFAULT 'info',
  message     TEXT NOT NULL,
  data        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events (job_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_job_events_item ON job_events (job_item_id, id DESC);
