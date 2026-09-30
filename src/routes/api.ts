import { Hono } from 'hono';
import { Repository } from '../db/repository';
import { badRequest, conflict, notConfigured, notFound, unauthorized } from '../core/errors';
import { jsonError, jsonOk, noContent, readJsonBody } from '../core/http';
import {
  analyzeSchema,
  createJobSchema,
  listFilesSchema,
  listJobsSchema,
  listSeriesSchema,
  parseOrThrow,
} from '../core/validate';
import type { Env } from '../env';
import { baseHeaders, grabConfig } from '../grab/config';
import { safeUrl } from '../grab/guard';
import { Budget, grabFetch } from '../grab/net';
import { isManifestContentType } from '../grab/manifests';
import { isErrorPageContentType, isMediaContentType, resolveFormat } from '../grab/media-types';
import {
  defaultConcurrency,
  fileUrlTtlSeconds,
  maxAttempts,
  mocksEnabled,
  queuePushBatchSize,
} from '../env';
import { resolveExtractor, describeExtractors } from '../providers/extract/registry';
import { describeDownloadProviders, resolveDownloadProvider } from '../providers/download/registry';
import { isListOnly, JobService } from '../jobs/service';
import { completeJobItemWithStream, finalizeJob, runMaintenance } from '../jobs/orchestrator';
import { callbackPayload, verifySignature } from '../providers/signature';
import { ensureRuntimeEnv, withAutoSchema } from '../runtime/fallbacks';
import type { WaitUntilContext } from '../runtime/fallbacks';
import type { EpisodeRecord, JobDetail, SeriesRecord } from '../shared/types';

export const app = new Hono<{ Bindings: Env }>();

app.use('*', async (context, next) => {
  let ctx: WaitUntilContext | undefined;
  try {
    ctx = context.executionCtx;
  } catch {
    ctx = undefined;
  }
  ensureRuntimeEnv(context.env, ctx, context.req.url);
  await next();
});

app.onError((error, _context) => jsonError(error));
app.notFound((context) =>
  jsonError(notFound(`No API route for ${context.req.method} ${context.req.path}`)),
);

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

app.get('/api/health', async (context) => {
  const env = context.env;
  let database = false;
  try {
    const row = await withAutoSchema(env.DB).prepare('SELECT 1 AS ok').first<{ ok: number }>();
    database = row?.ok === 1;
  } catch (error) {
    console.error('[vtgrab] health check failed', error);
  }
  return jsonOk({
    ok: database,
    service: 'vtgrab',
    environment: env.ENVIRONMENT,
    mocks: mocksEnabled(env),
    bindings: { database, bucket: Boolean(env.FILES), queue: Boolean(env.JOB_QUEUE) },
    time: new Date().toISOString(),
  });
});

app.get('/api/sources', (context) => {
  const env = context.env;
  return jsonOk({
    environment: env.ENVIRONMENT,
    time: new Date().toISOString(),
    bindings: { database: true, bucket: Boolean(env.FILES), queue: Boolean(env.JOB_QUEUE) },
    extractors: describeExtractors(env),
    downloadProviders: describeDownloadProviders(env),
    limits: {
      maxAttempts: maxAttempts(env),
      defaultQuality: env.DEFAULT_QUALITY,
      defaultContainer: env.DEFAULT_CONTAINER,
      defaultConcurrency: defaultConcurrency(env),
      queuePushBatchSize: queuePushBatchSize(env),
    },
    grab: describeGrab(env),
  });
});

/** What the real grabber is allowed to do on this deployment (for the UI). */
function describeGrab(env: Env) {
  const cfg = grabConfig(env);
  return {
    enabled: cfg.enabled,
    allowedHosts: cfg.allowlist,
    deniedHosts: cfg.denylist,
    allowPrivateHosts: cfg.allowPrivateHosts,
    maxVideos: cfg.maxVideos,
    maxVideoBytes: cfg.maxVideoBytes,
    chunkBytes: cfg.chunkBytes,
    probe: cfg.probe,
    followEmbeds: cfg.followEmbeds,
    crawl: cfg.crawl,
    maxCrawlPages: cfg.maxCrawlPages,
  };
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

/**
 * Analyze a link.
 *
 * For the real grabber (`http-sniff`) this is the whole "open the URL, find the
 * videos" step: the Worker fetches the page, sniffs every media source it can see
 * (including embedded players and linked episode pages), confirms each one against
 * the media host and stores the result as a series + episodes in D1.
 *
 * `queueAll: true` additionally creates the download job immediately, so one click
 * puts every found video into the queue.
 */
app.post('/api/analyze', async (context) => {
  const env = context.env;
  const repo = new Repository(env);
  const input = parseOrThrow(analyzeSchema, await readJsonBody(context.req.raw));
  const url = new URL(input.url);

  if (!input.refresh) {
    const cached = await repo.getSeriesBySourceUrl(url.toString());
    if (cached) {
      const episodes = await repo.listEpisodes(cached.id);
      const job = input.queueAll && episodes.some((episode) => !isListOnly(episode))
        ? await autoQueue(env, repo, cached.id)
        : null;
      return jsonOk({
        series: cached,
        episodes,
        extractor: cached.sourceKey,
        cached: true,
        ...(job ? { job } : {}),
      });
    }
  }

  const extractor = resolveExtractor(url, env, input.sourceKey);
  // Bound the whole sniffing pass: a slow host must not hold the request open.
  const controller = new AbortController();
  const analyzeBudgetMs = Math.max(8_000, Math.min(50_000, grabConfig(env).pageTimeoutMs * 3));
  const timer = setTimeout(() => controller.abort(new Error(`analyze exceeded its ${analyzeBudgetMs}ms budget`)), analyzeBudgetMs);
  let extracted;
  try {
    extracted = await extractor.extract(url, env, controller.signal);
  } finally {
    clearTimeout(timer);
  }

  const series = await repo.upsertSeries({
    sourceKey: extracted.sourceKey,
    sourceUrl: extracted.sourceUrl,
    canonicalUrl: extracted.canonicalUrl,
    title: extracted.title,
    synopsis: extracted.synopsis ?? null,
    posterUrl: extracted.posterUrl ?? null,
    metadata: extracted.metadata ?? {},
  });

  const episodes = await repo.replaceEpisodes(
    series.id,
    extracted.episodes.map((episode) => ({
      episodeIndex: episode.index,
      title: episode.title,
      sourceUrl: episode.url,
      durationSeconds: episode.durationSeconds ?? null,
      thumbnailUrl: episode.thumbnailUrl ?? null,
      streams: episode.streams,
      metadata: episode.metadata ?? {},
    })),
  );

  let job: JobDetail | null = null;
  // List-only results (TikTok analyzer) have nothing to queue; that is not an error.
  if (input.queueAll && episodes.some((episode) => !isListOnly(episode))) {
    job = await autoQueue(env, repo, series.id);
  }

  return jsonOk({ series, episodes, extractor: extractor.key, cached: false, ...(job ? { job } : {}) }, 200);
});

/** Create (and queue) an "everything" job for a freshly analyzed series. */
async function autoQueue(env: Env, repo: Repository, seriesId: string): Promise<JobDetail> {
  try {
    return await new JobService(env, repo).createJob({
      seriesId,
      selection: { mode: 'all' },
      options: { concurrency: defaultConcurrency(env) },
    });
  } catch (error) {
    // The analysis result is still useful on its own, so report it with a warning.
    console.warn(`[vtgrab] auto-queue failed for ${seriesId}: ${(error as Error).message}`);
    throw error;
  }
}

/**
 * GET /api/preview?url=<media url>
 *
 * Plays a grabbed source in the browser through the Worker, which is how you check
 * a result when the media host blocks hotlinking or the page is https/mixed.
 *
 * It is deliberately narrow: the same host policy as the grabber applies (no
 * private/metadata addresses, optional allow-list), only video/audio/manifest
 * responses are passed through, no cookies or authorization headers are forwarded,
 * `Range` is passed through for seeking, and the stream size is capped.
 */
app.get('/api/preview', async (context) => {
  const env = context.env;
  const cfg = grabConfig(env);
  if (!cfg.enabled) {
    throw notConfigured('Preview is off because the real grabber is disabled (GRAB_ENABLED=false).');
  }
  const raw = context.req.query('url');
  if (!raw) throw badRequest('Missing "url" query parameter');

  const target = safeUrl(raw, cfg).url;
  const headers: Record<string, string> = { ...baseHeaders(cfg, target.toString()), accept: '*/*' };
  const range = context.req.header('range');
  if (range && /^bytes=\d*-\d*$/.test(range.trim())) headers.range = range.trim();

  const { response } = await grabFetch(
    target,
    cfg,
    { method: 'GET', headers, timeoutMs: cfg.mediaTimeoutMs },
    new Budget(2),
  );

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const normalizedType = contentType.split(';')[0].trim().toLowerCase();
  const genericBinary = ['', 'application/octet-stream', 'binary/octet-stream', 'application/binary'].includes(normalizedType);
  const inferredFormat = genericBinary ? resolveFormat(target.toString()) : null;
  const refuse = (message: string): never => {
    void response.body?.cancel().catch(() => undefined);
    throw badRequest(message);
  };
  if (isManifestContentType(contentType) || /\.(?:m3u8?|mpd)(\?|$)/i.test(target.pathname)) {
    refuse('This source is an HLS/DASH manifest, not a single file: queue the download to get one playable .ts/.mp4.');
  }
  if (isErrorPageContentType(contentType) || (!isMediaContentType(contentType) && !inferredFormat)) {
    refuse(`Refusing to proxy "${normalizedType || 'unknown'}" - only media responses can be previewed.`);
  }

  const previewContentType = inferredFormat?.contentType ?? contentType;
  const out = new Headers({
    'content-type': previewContentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  for (const header of ['content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(header);
    if (value) out.set(header, value);
  }
  return new Response(response.body, { status: response.status, headers: out });
});

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

app.get('/api/series', async (context) => {
  const repo = new Repository(context.env);
  const query = parseOrThrow(listSeriesSchema, context.req.query());
  const result = await repo.listSeries(query);
  return jsonOk({ ...result, limit: query.limit, offset: query.offset });
});

app.get('/api/series/:id', async (context) => {
  const repo = new Repository(context.env);
  const series: SeriesRecord | null = await repo.getSeries(context.req.param('id'));
  if (!series) throw notFound(`Series ${context.req.param('id')} not found`);
  const episodes: EpisodeRecord[] = await repo.listEpisodes(series.id);
  return jsonOk({ series, episodes });
});

app.get('/api/series/:id/episodes', async (context) => {
  const repo = new Repository(context.env);
  const episodes = await repo.listEpisodes(context.req.param('id'));
  return jsonOk({ episodes, total: episodes.length });
});

app.delete('/api/series/:id', async (context) => {
  const repo = new Repository(context.env);
  const series = await repo.getSeries(context.req.param('id'));
  if (!series) throw notFound(`Series ${context.req.param('id')} not found`);
  await repo.deleteSeries(series.id);
  return noContent();
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

app.post('/api/jobs', async (context) => {
  const env = context.env;
  const input = parseOrThrow(createJobSchema, await readJsonBody(context.req.raw));
  const detail = await new JobService(env, new Repository(env)).createJob(input);
  return jsonOk(detail, 201);
});

app.get('/api/jobs', async (context) => {
  const repo = new Repository(context.env);
  const query = parseOrThrow(listJobsSchema, context.req.query());
  const result = await repo.listJobs(query);
  return jsonOk({ ...result, limit: query.limit, offset: query.offset });
});

app.get('/api/jobs/:id', async (context) => {
  const repo = new Repository(context.env);
  return jsonOk(await repo.jobDetail(context.req.param('id')));
});

app.get('/api/jobs/:id/events', async (context) => {
  const repo = new Repository(context.env);
  const limit = Math.min(500, Math.max(1, Number.parseInt(context.req.query('limit') ?? '200', 10) || 200));
  const events = await repo.listEvents(context.req.param('id'), limit);
  return jsonOk({ events });
});

app.post('/api/jobs/:id/cancel', async (context) => {
  const env = context.env;
  const detail = await new JobService(env, new Repository(env)).cancel(context.req.param('id'));
  return jsonOk(detail);
});

app.post('/api/jobs/:id/retry', async (context) => {
  const env = context.env;
  const detail = await new JobService(env, new Repository(env)).retry(context.req.param('id'));
  return jsonOk(detail);
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

app.get('/api/files', async (context) => {
  const repo = new Repository(context.env);
  const query = parseOrThrow(listFilesSchema, context.req.query());
  const result = await repo.listFiles(query);
  return jsonOk({ ...result, limit: query.limit, offset: query.offset });
});

app.get('/api/files/:id', async (context) => {
  const repo = new Repository(context.env);
  const file = await repo.getFile(context.req.param('id'));
  if (!file) throw notFound(`File ${context.req.param('id')} not found`);
  return jsonOk({ file, downloadUrl: `/api/files/${file.id}/content` });
});

/** Stream the stored object out of R2 (supports HTTP Range requests). */
app.get('/api/files/:id/content', async (context) => {
  const env = context.env;
  const repo = new Repository(env);
  const file = await repo.getFile(context.req.param('id'));
  if (!file) throw notFound(`File ${context.req.param('id')} not found`);

  const rangeHeader = context.req.header('range');
  const range = parseRange(rangeHeader, file.size);

  const object = range
    ? ((await env.FILES.get(file.objectKey, { range })) as R2ObjectBody | null)
    : ((await env.FILES.get(file.objectKey)) as R2ObjectBody | null);

  if (!object || !object.body) throw notFound(`Object ${file.objectKey} is missing from R2`);

  const storedContentType = object.httpMetadata?.contentType ?? file.contentType;
  const normalizedType = storedContentType.split(';')[0].trim().toLowerCase();
  let inlineMediaType: string | null = null;
  if (file.provider !== 'mock') {
    if (normalizedType.startsWith('video/') || normalizedType.startsWith('audio/')) {
      inlineMediaType = storedContentType;
    } else if (['', 'application/octet-stream', 'binary/octet-stream', 'application/binary'].includes(normalizedType)) {
      const format = resolveFormat(file.filename);
      if (format && !format.manifest && (format.contentType.startsWith('video/') || format.contentType.startsWith('audio/'))) {
        inlineMediaType = format.contentType;
      }
    }
  }
  const inline = context.req.query('inline') === '1' && inlineMediaType !== null;
  const headers = new Headers({
    'content-type': inline ? inlineMediaType! : storedContentType,
    'content-length': String(range ? range.length : file.size),
    'accept-ranges': 'bytes',
    'cache-control': `private, max-age=${fileUrlTtlSeconds(env)}`,
    'x-content-type-options': 'nosniff',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.filename.replace(/"/g, '')}"`,
  });
  if (object.etag) headers.set('etag', object.etag);
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
  }

  return new Response(object.body, { status: range ? 206 : 200, headers });
});

app.delete('/api/files/:id', async (context) => {
  const env = context.env;
  const repo = new Repository(env);
  const file = await repo.deleteFile(context.req.param('id'));
  if (!file) throw notFound(`File ${context.req.param('id')} not found`);
  await env.FILES.delete(file.objectKey);
  const item = file.jobItemId ? await repo.getJobItem(file.jobItemId) : null;
  if (item) {
    await repo.updateJobItem(item.id, { fileId: null, bytes: 0, status: 'pending', progress: 0 });
  }
  return noContent();
});

interface ByteRange {
  offset: number;
  length: number;
}

function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}

// ---------------------------------------------------------------------------
// Internal: authorized download service callback + maintenance
// ---------------------------------------------------------------------------

/**
 * PUT /api/internal/provider/callback/:jobItemId?expires=...&sig=sha256=...
 *
 * The external (authorized) download service streams the finished object here.
 * The request is authenticated with HMAC-SHA256 over `<jobItemId>.<expires>`.
 */
app.put('/api/internal/provider/callback/:jobItemId', async (context) => {
  const env = context.env;
  const repo = new Repository(env);
  const jobItemId = context.req.param('jobItemId');
  const expires = Number.parseInt(context.req.query('expires') ?? '0', 10);
  const signature = context.req.query('sig') ?? context.req.header('x-vtgrab-signature') ?? null;
  const providerRef = context.req.query('ref') ?? context.req.header('x-vtgrab-ref') ?? null;

  const secret = env.DOWNLOAD_CALLBACK_SECRET;
  if (!secret) {
    throw notConfigured(
      'DOWNLOAD_CALLBACK_SECRET is not set, so provider callbacks cannot be verified.',
    );
  }
  if (!Number.isFinite(expires) || expires <= 0) {
    throw badRequest('Missing or invalid "expires" query parameter');
  }
  if (Math.floor(Date.now() / 1000) > expires) {
    throw unauthorized('Callback URL has expired');
  }
  const valid = await verifySignature(secret, callbackPayload(jobItemId, expires), signature);
  if (!valid) {
    throw unauthorized('Invalid callback signature');
  }

  const item = await repo.getJobItem(jobItemId);
  if (!item) throw notFound(`Job item ${jobItemId} not found`);
  if (item.status === 'cancelled') {
    throw conflict('Job item was cancelled');
  }

  if (!context.req.raw.body) {
    throw badRequest('Callback request has an empty body');
  }

  const file = await completeJobItemWithStream(env, repo, {
    item,
    stream: context.req.raw.body,
    contentType: context.req.header('content-type') ?? 'application/octet-stream',
    contentLength: Number.parseInt(context.req.header('content-length') ?? '0', 10) || undefined,
    providerKey: item.provider ?? 'remote',
  });

  if (providerRef) {
    await repo.updateJobItem(item.id, { providerRef });
  }
  await repo.appendEvent({
    jobId: item.jobId,
    jobItemId: item.id,
    level: 'info',
    message: `Provider callback stored ${file.size} bytes`,
    data: { providerRef, fileId: file.id },
  });
  await finalizeJob(env, repo, item.jobId);

  return jsonOk({ ok: true, fileId: file.id, size: file.size }, 201);
});

/** Manually trigger the same maintenance the cron runs (polls/fails stale items). */
app.post('/api/internal/maintenance', async (context) => {
  const env = context.env;
  const secret = env.DOWNLOAD_CALLBACK_SECRET;
  if (secret) {
    const provided = context.req.header('authorization') ?? '';
    const expected = `Bearer ${secret}`;
    if (provided !== expected) throw unauthorized('Invalid maintenance token');
  } else {
    throw unauthorized('Maintenance endpoint is disabled because DOWNLOAD_CALLBACK_SECRET is unset');
  }
  const limit = Math.min(200, Math.max(1, Number.parseInt(context.req.query('limit') ?? '50', 10) || 50));
  const result = await runMaintenance(env, new Repository(env), limit);
  return jsonOk(result);
});

/** Introspection used by the frontend to know which provider will be used. */
app.get('/api/providers', (context) => {
  const env = context.env;
  let providerKey: string | null = null;
  try {
    providerKey = resolveDownloadProvider(env).key;
  } catch {
    providerKey = null;
  }
  return jsonOk({
    defaultProvider: providerKey,
    extractors: describeExtractors(env),
    downloadProviders: describeDownloadProviders(env),
  });
});
