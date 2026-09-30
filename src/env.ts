import type { QueueMessage } from './queue/messages';

/**
 * Cloudflare bindings + configuration for the VTGrab Worker.
 *
 * Secrets (SOURCE_API_TOKEN, DOWNLOAD_SERVICE_TOKEN, DOWNLOAD_CALLBACK_SECRET)
 * are never stored in this repository: they are provided through
 * `wrangler secret put` or `.dev.vars` (git-ignored) for local development.
 */
export interface Env {
  /** D1 metadata database. */
  DB: D1Database;
  /** R2 bucket holding completed media objects. */
  FILES: R2Bucket;
  /** Queue used to fan out download work. */
  JOB_QUEUE: Queue<QueueMessage>;
  /** Static assets (the Vite build in ./dist). Absent in the test environment. */
  ASSETS?: Fetcher;

  // ---- plain vars -----------------------------------------------------------
  ENVIRONMENT: string;
  MOCK_ENABLED: string;
  MAX_ATTEMPTS: string;
  DEFAULT_QUALITY: string;
  DEFAULT_CONTAINER: string;
  DEFAULT_CONCURRENCY: string;
  FILE_URL_TTL_SECONDS: string;
  QUEUE_PUSH_BATCH_SIZE: string;
  STALE_ITEM_MINUTES: string;
  /** Comma separated allow-list of hostnames the authorized extractor may call. */
  SOURCE_ALLOWED_HOSTS: string;
  /** Public origin of this Worker, used to build provider callback URLs. */
  PUBLIC_BASE_URL: string;

  // ---- authorized source (extractor) ---------------------------------------
  SOURCE_API_BASE_URL?: string;
  SOURCE_API_TOKEN?: string;

  // ---- authorized download service (production provider) -------------------
  DOWNLOAD_SERVICE_URL?: string;
  DOWNLOAD_SERVICE_TOKEN?: string;
  /** Shared HMAC secret used to sign/verify provider callbacks. */
  DOWNLOAD_CALLBACK_SECRET?: string;
  /** Public base URL the download service uses to reach our callback endpoint. */
  DOWNLOAD_CALLBACK_URL?: string;
}

export function isProduction(env: Env): boolean {
  return String(env.ENVIRONMENT ?? '').toLowerCase() === 'production';
}

export function mocksEnabled(env: Env): boolean {
  const raw = String(env.MOCK_ENABLED ?? '').toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Default: mocks follow the environment (on for dev/test/preview, off in prod).
  return !isProduction(env);
}

export function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function maxAttempts(env: Env): number {
  return num(env, 'MAX_ATTEMPTS', 3);
}

export function queuePushBatchSize(env: Env): number {
  // Cloudflare Queues accepts at most 100 messages per sendBatch() call.
  return Math.min(100, num(env, 'QUEUE_PUSH_BATCH_SIZE', 100));
}

export function defaultConcurrency(env: Env): number {
  return Math.max(1, Math.min(20, num(env, 'DEFAULT_CONCURRENCY', 4)));
}

/** Seconds a stored object may be cached downstream (`/api/files/:id/content`). */
export function fileUrlTtlSeconds(env: Env): number {
  return Math.max(0, num(env, 'FILE_URL_TTL_SECONDS', 3600));
}
