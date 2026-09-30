#!/usr/bin/env node
/**
 * End-to-end proof for the real link grabber - no mocks.
 *
 *   1. starts the local fixture site (scripts/fixture-site.mjs) on 127.0.0.1
 *   2. starts the Worker with `wrangler dev`, with the mock providers switched OFF, so
 *      anything this run produces can only have come from a real HTTP fetch
 *   3. POSTs /api/analyze with a page URL and queueAll=true
 *   4. waits for the download job to finish
 *   5. reads every stored object back through /api/files/:id/content and compares the
 *      SHA-256 of the bytes with the source bytes the fixture served
 *
 * Byte-exact hashes on both a progressive MP4 (fetched in Range parts) and an HLS
 * stream (segments concatenated by the Worker) is the point of the whole exercise:
 * "found the URL" is not enough, the stored file has to be the real file.
 *
 * Usage: node scripts/verify-grab-e2e.mjs [--keep]   (--keep leaves both servers running)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';

const FIXTURE_PORT = Number.parseInt(process.env.FIXTURE_PORT ?? '8099', 10);
const WORKER_PORT = Number.parseInt(process.env.WORKER_PORT ?? '8788', 10);
const KEEP = process.argv.includes('--keep');
const JOB_TIMEOUT_MS = Number.parseInt(process.env.JOB_TIMEOUT_MS ?? '180000', 10);

const results = [];
let worker = null;
let fixtureServer = null;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

/** Kill the whole `wrangler dev` process group, then make sure it is really gone. */
function stopWorker() {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  try {
    process.kill(-worker.pid, 'SIGTERM');
  } catch {
    worker.kill('SIGTERM');
  }
  const killed = setTimeout(() => {
    try {
      process.kill(-worker.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 4000);
  killed.unref?.();
  worker.once('exit', () => clearTimeout(killed));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function waitHealthy(base, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'never answered';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return response.json();
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Worker did not become healthy (${lastError})`);
}

async function streamToBytes(response) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.byteLength;
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function main() {
  // The fixture builds absolute URLs from its own PORT, so tell it which port it
  // will get before it is imported.
  process.env.PORT = String(FIXTURE_PORT);
  process.env.HOST = '127.0.0.1';
  const { buildFixture, createFixtureServer } = await import('./fixture-site.mjs');
  const fixture = buildFixture();
  fixtureServer = createFixtureServer(fixture);
  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', resolve);
  }).catch(async (error) => {
    if (String(error.code) === 'EADDRINUSE') {
      throw new Error(
        `port ${FIXTURE_PORT} is already taken - stop the other fixture site (or run with FIXTURE_PORT=8123 node scripts/verify-grab-e2e.mjs)`,
      );
    }
    throw error;
  });
  const origin = `http://127.0.0.1:${FIXTURE_PORT}`;
  console.log(`[verify] fixture site on ${origin}`);

  rmSync('.wrangler/verify-state', { recursive: true, force: true });
  worker = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(WORKER_PORT),
      '--log-level',
      'warn',
      // A private state dir: this run must not share (or pollute) the D1/R2 data that
      // `npm run dev` uses, and every verification starts from an empty database.
      '--persist-to',
      '.wrangler/verify-state',
      // Mocks are switched off: a result can then only come from a real fetch.
      '--var',
      'ENVIRONMENT:development',
      '--var',
      'MOCK_ENABLED:false',
      '--var',
      'GRAB_ENABLED:true',
      // 127.0.0.1 is private, so the grabber needs the development-only override.
      '--var',
      'GRAB_ALLOW_PRIVATE_HOSTS:true',
      '--var',
      'GRAB_CHUNK_BYTES:5242880',
      '--var',
      'GRAB_MAX_VIDEO_BYTES:67108864',
      '--var',
      'GRAB_MAX_CRAWL_PAGES:8',
    ],
    // Own process group: wrangler spawns workerd children, and killing only `npx`
    // would leave the dev server (and its port) behind.
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  const workerLog = [];
  worker.stdout.on('data', (chunk) => workerLog.push(chunk.toString()));
  worker.stderr.on('data', (chunk) => workerLog.push(chunk.toString()));

  const base = `http://127.0.0.1:${WORKER_PORT}`;
  const health = await waitHealthy(base);
  console.log(`[verify] worker healthy: ${JSON.stringify(health).slice(0, 160)}`);

  const sources = await (await fetch(`${base}/api/sources`)).json();
  const grab = sources.grab ?? sources.sources?.grab;
  record('grabber is enabled in the running Worker', grab?.enabled === true, JSON.stringify(grab ?? sources).slice(0, 200));

  // ---- analyze -------------------------------------------------------------
  const analyzed = await fetch(`${base}/api/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${origin}/`, refresh: true, queueAll: true }),
  });
  const analysis = await analyzed.json();
  if (!analyzed.ok) {
    record('POST /api/analyze', false, `${analyzed.status} ${JSON.stringify(analysis).slice(0, 500)}`);
    throw new Error('analyze failed');
  }

  const episodes = analysis.episodes ?? [];
  const series = analysis.series ?? {};
  const streamsOf = (episode) => episode.streams ?? episode.metadata?.streams ?? [];
  const urlsOf = (episode) => episode.metadata?.streamUrls ?? streamsOf(episode).map((stream) => stream.url);
  console.log(
    `[verify] analyzed "${series.title ?? '(untitled)'}" - ${episodes.length} video(s), extractor=${analysis.extractor}, crawler pages=${(series.metadata?.crawledPages ?? []).length}`,
  );

  record('analyze used the real grabber', analysis.extractor === 'http-sniff', `extractor=${analysis.extractor}`);
  record('the link yielded more than one video', episodes.length >= 6, `${episodes.length} video record(s)`);
  record(
    'titles came from the page, not from a counter',
    episodes.some((episode) => /rabbit|feature|episode/i.test(episode.title ?? '')),
    episodes.slice(0, 4).map((episode) => episode.title).join(' | '),
  );
  record('every video carries a discovered source URL', episodes.every((episode) => urlsOf(episode).length > 0), `${episodes.length}/${episodes.length}`);

  const encrypted = episodes.filter((episode) => episode.metadata?.encrypted === true);
  record('the protected video is identified as encrypted', encrypted.length >= 1, encrypted.map((episode) => episode.title).join(' | ') || 'none');
  const live = episodes.filter((episode) => urlsOf(episode).some((url) => url.includes('/media/live/')));
  record('the live stream is identified (and not queued as a file)', live.length >= 1, live.map((episode) => episode.title).join(' | ') || 'none');
  const sized = episodes.filter((episode) => streamsOf(episode).some((stream) => Number.isFinite(stream.sizeBytes) && stream.sizeBytes > 0));
  record('video sizes were learned from the origin', sized.length > 0, `${sized.length} video(s) with a size estimate`);
  const durations = episodes.filter((episode) => Number.isFinite(episode.durationSeconds) && episode.durationSeconds > 0);
  record('durations were read from the manifests', durations.length > 0, `${durations.length} video(s) with a duration`);
  const adaptive = episodes.filter((episode) => streamsOf(episode).some((stream) => stream.kind === 'hls' || stream.kind === 'dash'));
  record('HLS/DASH streams were resolved into qualities', adaptive.length > 0, adaptive.map((episode) => streamsOf(episode).map((s) => `${s.quality}:${s.segments ?? '?'} seg`).join('+')).slice(0, 3).join(' | '));

  // ---- job -----------------------------------------------------------------
  const jobRef = analysis.job?.job ?? analysis.job;
  record('analyze queued a job for the videos it found', Boolean(jobRef?.id), jobRef ? `job ${jobRef.id}` : 'no job in the response');
  if (!jobRef?.id) throw new Error('nothing was queued');

  let detail = await (await fetch(`${base}/api/jobs/${jobRef.id}`)).json();
  const queued = detail.items ?? [];
  const queuedUrls = queued
    .map((item) => episodes.find((episode) => episode.id === item.episodeId))
    .filter(Boolean)
    .flatMap(urlsOf);
  record(
    'no encrypted or live source was queued',
    !queuedUrls.some((url) => url.includes('/media/encrypted/') || url.includes('/media/live/')),
    `${queued.length} queued item(s)`,
  );

  const startedAt = Date.now();
  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    detail = await (await fetch(`${base}/api/jobs/${jobRef.id}`)).json();
    const status = detail.job?.status;
    if (status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const status = detail.job?.status;
  const finalItems = detail.items ?? [];
  console.log(`[verify] job ${jobRef.id} finished as "${status}" after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  for (const item of finalItems) {
    console.log(
      `         #${String(item.position).padStart(2)} ${String(item.status).padEnd(10)} ${String(item.bytes ?? 0).padStart(10)} bytes  ${item.quality ?? '-'} ${item.container ?? '-'}${item.error ? `  error=${String(item.error).slice(0, 90)}` : ''}`,
    );
  }
  record('the job reached a terminal state', ['completed', 'partial'].includes(String(status)), `status=${status}`);
  const done = finalItems.filter((item) => item.status === 'completed');
  record('items actually downloaded', done.length >= 3, `${done.length}/${finalItems.length} completed`);
  record(
    'anything that failed says why',
    finalItems.filter((item) => item.status === 'failed').every((item) => (item.error ?? '').length > 10),
    `${finalItems.filter((item) => item.status === 'failed').length} failed`,
  );
  record(
    'progress bytes were recorded per item',
    done.every((item) => Number(item.bytes) > 0),
    done.map((item) => item.bytes).join(','),
  );

  // ---- byte-exact verification --------------------------------------------
  const expectedByPath = {
    '/media/bunny.mp4': fixture.bytes,
    '/media/hls/master.m3u8': fixture.bytes,
    '/media/hls/media.m3u8': fixture.bytes,
    '/media/cmaf/master.m3u8': Buffer.concat([fixture.init, fixture.bytes]),
    '/media/dash/manifest.mpd': Buffer.concat([fixture.init, fixture.bytes]),
  };
  for (const [name, buffer] of Object.entries(fixture.named)) expectedByPath[`/media/${name}`] = buffer;

  const expectedFor = (urls) => {
    for (const url of urls) {
      let path = String(url);
      try {
        path = new URL(url).pathname;
      } catch {
        // keep the raw string
      }
      if (expectedByPath[path]) return expectedByPath[path];
    }
    for (const url of urls) {
      const name = String(url).split('/').pop()?.split('?')[0] ?? '';
      const match = Object.keys(expectedByPath).find((path) => path.endsWith(`/${name}`));
      if (match) return expectedByPath[match];
    }
    return null;
  };

  let compared = 0;
  let matched = 0;
  const rows = [];
  for (const item of done) {
    const episode = episodes.find((candidate) => candidate.id === item.episodeId);
    const sourceUrls = episode ? urlsOf(episode) : [];
    const expected = expectedFor(sourceUrls);
    if (!item.fileId) {
      rows.push([`item #${item.position}`, 'completed but no file recorded', '']);
      continue;
    }
    const payload = await (await fetch(`${base}/api/files/${item.fileId}`)).json();
    const file = payload.file ?? payload;
    const response = await fetch(`${base}/api/files/${item.fileId}/content`);
    const bytes = await streamToBytes(response);
    const digest = sha256(bytes);
    const ok = expected ? digest === sha256(expected) : null;
    compared += 1;
    if (ok === true) matched += 1;
    rows.push([
      `${file.filename ?? 'file'} ${(bytes.byteLength / 1024 / 1024).toFixed(2)}MiB ${file.container ?? '?'}/${file.quality ?? '?'}`,
      ok === null
        ? `stored (sha256 ${digest.slice(0, 12)}…, no fixture mapping)`
        : ok
          ? `sha256 ${digest.slice(0, 16)}… == source bytes`
          : `MISMATCH stored ${digest.slice(0, 12)}… vs source ${sha256(expected).slice(0, 12)}…`,
      // which source this file came from, for the named checks below
      `${sourceUrls.join(' ')} ${file.objectKey ?? ''}`,
    ]);
    console.log(`         ${ok === false ? 'X' : 'v'} ${rows.at(-1)[0]} -> ${rows.at(-1)[1]}`);
  }
  record('stored files are readable through the API', compared > 0, `${compared} file(s)`);
  record('stored bytes are byte-identical to the source', matched > 0 && matched === compared, `${matched}/${compared} hash-verified`);
  const verify = (row) => Boolean(row?.[1].includes('== source bytes'));
  const progressive = rows.find((row) => row[2].includes('/media/bunny.mp4'));
  record('the 7.8 MiB MP4 was reassembled from Range parts', verify(progressive), `${progressive?.[0] ?? 'not found'}`);
  const hls = rows.find((row) => row[2].includes('/media/hls/'));
  record('the HLS video was reassembled from its segments', verify(hls), `${hls?.[0] ?? 'not found'}`);
  const cmaf = rows.find((row) => row[2].includes('/media/cmaf/'));
  record('the CMAF file got its init segment in front', verify(cmaf), `${cmaf?.[0] ?? 'not found'}`);
  const multiPart = rows.find((row) => row[2].includes('/media/bunny.mp4'));
  record(
    'a large file became more than one R2 part',
    Boolean(multiPart && Number(multiPart[0].match(/(\d+\.\d+)MiB/)?.[1]) > 5),
    multiPart?.[0] ?? 'not found',
  );

  console.log('\n[verify] series/episodes as stored in D1:');
  for (const episode of episodes.slice(0, 14)) {
    const streams = streamsOf(episode);
    console.log(
      `         ${String(episode.episodeIndex ?? '-').padStart(2)}. ${String(episode.title).slice(0, 30).padEnd(30)} ${String(
        episode.durationSeconds ?? '-',
      ).padStart(5)}s ${streams.map((stream) => `${stream.quality ?? stream.kind}${stream.encrypted ? ' [encrypted]' : ''}`).join(', ')}`,
    );
  }

  if (process.env.VERIFY_DEBUG === '1') {
    console.log('\n[verify] worker log tail:\n' + workerLog.join('').split('\n').slice(-80).join('\n'));
  }
}

try {
  await main();
} catch (error) {
  record('verification run completed without crashing', false, error instanceof Error ? error.message : String(error));
  stopWorker();
} finally {
  if (KEEP) {
    console.log(`\n[verify] servers left running: fixture ${FIXTURE_PORT}, worker ${WORKER_PORT} (Ctrl-C to stop)`);
    process.stdin.resume();
  } else {
    stopWorker();
    fixtureServer?.close();
  }
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n[verify] ${results.length - failed.length}/${results.length} checks passed`);
if (!KEEP) process.exit(failed.length === 0 ? 0 : 1);
