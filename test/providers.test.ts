import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthorizedHttpExtractor, allowedHosts, buildSeriesRequest } from '../worker/src/providers/extract/authorized';
import {
  RemoteDownloadProvider,
  buildSubmitRequest,
  CALLBACK_TTL_SECONDS,
} from '../worker/src/providers/download/remote';
import { resolveDownloadProvider } from '../worker/src/providers/download/registry';
import { resolveExtractor } from '../worker/src/providers/extract/registry';
import {
  callbackPayload,
  hmacHex,
  signedCallbackUrl,
  timingSafeEqual,
  verifySignature,
} from '../worker/src/providers/signature';
import { completeJobItemWithStream, finalizeJob, runMaintenance } from '../worker/src/jobs/orchestrator';
import { buildDownloadRequest, callbackOrigin } from '../worker/src/jobs/orchestrator';
import { Repository } from '../worker/src/db/repository';
import type { Env } from '../worker/src/env';
import { requestJson, seedJob, testEnv } from './helpers';
import type { JobDetail, JobRecord, JobItemRecord } from '../worker/src/shared/types';

const SECRET = 'test-callback-secret';

function remoteEnv(): Env {
  return {
    ...testEnv,
    DOWNLOAD_SERVICE_URL: 'https://downloads.example.com',
    DOWNLOAD_SERVICE_TOKEN: 'service-token',
    DOWNLOAD_CALLBACK_SECRET: SECRET,
    DOWNLOAD_CALLBACK_URL: 'https://vtgrab.example.com',
    PUBLIC_BASE_URL: 'https://vtgrab.example.com',
  } as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HMAC signing helpers', () => {
  it('produces stable hex signatures', async () => {
    const first = await hmacHex('secret', 'payload');
    const second = await hmacHex('secret', 'payload');
    const other = await hmacHex('secret', 'payload2');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies signatures in constant time', async () => {
    const signature = await hmacHex('secret', callbackPayload('jit_1', 1700000000));
    expect(await verifySignature('secret', callbackPayload('jit_1', 1700000000), `sha256=${signature}`)).toBe(true);
    expect(await verifySignature('secret', callbackPayload('jit_1', 1700000000), signature)).toBe(true);
    expect(await verifySignature('secret', callbackPayload('jit_2', 1700000000), signature)).toBe(false);
    expect(await verifySignature('secret', callbackPayload('jit_1', 1700000000), '')).toBe(false);
    expect(await verifySignature('secret', callbackPayload('jit_1', 1700000000), null)).toBe(false);
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('builds signed callback URLs', async () => {
    const expires = 1700000000;
    const url = await signedCallbackUrl({}, 'https://worker.example.com', 'jit_9', expires, SECRET);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/internal/provider/callback/jit_9');
    expect(parsed.searchParams.get('expires')).toBe(String(expires));
    const signature = parsed.searchParams.get('sig')!;
    expect(await verifySignature(SECRET, callbackPayload('jit_9', expires), signature)).toBe(true);

    const overridden = await signedCallbackUrl(
      { DOWNLOAD_CALLBACK_URL: 'https://cb.example.com' },
      'https://worker.example.com',
      'jit_9',
      expires,
      SECRET,
    );
    expect(new URL(overridden).origin).toBe('https://cb.example.com');
    expect(callbackOrigin({ ...testEnv, PUBLIC_BASE_URL: 'https://base.example.com/' } as Env)).toBe(
      'https://base.example.com',
    );
  });
});

describe('AuthorizedHttpExtractor (production integration point)', () => {
  const extractor = new AuthorizedHttpExtractor();

  it('is unavailable until SOURCE_API_BASE_URL is configured', () => {
    expect(extractor.isConfigured(testEnv)).toBe(false);
    expect(extractor.canHandle(new URL('https://anything.example/series/1'), testEnv)).toBe(false);
    expect(() => buildSeriesRequest(new URL('https://x.example/1'), testEnv)).toThrow(
      /SOURCE_API_BASE_URL is not configured/,
    );
    expect(extractor.describe(testEnv).reason).toContain('SOURCE_API_BASE_URL');
  });

  it('honours the host allow-list once configured', () => {
    const env = {
      ...testEnv,
      SOURCE_API_BASE_URL: 'https://catalog.example.com/v1',
      SOURCE_ALLOWED_HOSTS: ' watch.example.com , other.example.com ',
    } as Env;

    expect(allowedHosts(env)).toEqual(['watch.example.com', 'other.example.com']);
    expect(extractor.isConfigured(env)).toBe(true);
    expect(extractor.canHandle(new URL('https://watch.example.com/series/7'), env)).toBe(true);
    expect(extractor.canHandle(new URL('https://evil.example.com/series/7'), env)).toBe(false);
    expect(extractor.describe(env).available).toBe(true);
  });

  it('builds a Bearer-authenticated request against the catalog API', () => {
    const env = {
      ...testEnv,
      SOURCE_API_BASE_URL: 'https://catalog.example.com',
      SOURCE_API_TOKEN: 'source-token',
    } as Env;
    const { url, init } = buildSeriesRequest(new URL('https://watch.example.com/series/7'), env);
    expect(url).toBe('https://catalog.example.com/v1/series?url=https%3A%2F%2Fwatch.example.com%2Fseries%2F7');
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer source-token');
    expect(headers.accept).toBe('application/json');
  });

  it('validates the catalog response contract', async () => {
    const env = {
      ...testEnv,
      SOURCE_API_BASE_URL: 'https://catalog.example.com/v1',
      SOURCE_ALLOWED_HOSTS: 'watch.example.com',
    } as Env;

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            id: 'src_1',
            title: 'Authorized Series',
            episodes: [{ index: 1, title: 'Episode 1', url: 'https://watch.example.com/e/1', streams: [] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const extracted = await new AuthorizedHttpExtractor().extract(
      new URL('https://watch.example.com/series/1'),
      env,
    );
    expect(extracted.sourceKey).toBe('authorized-http');
    expect(extracted.title).toBe('Authorized Series');
    expect(extracted.canonicalUrl).toBe('authorized-http:src_1');
    expect(extracted.episodes).toHaveLength(1);

    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await expect(
      new AuthorizedHttpExtractor().extract(new URL('https://watch.example.com/series/1'), env),
    ).rejects.toThrow(/responded 500/);
  });
});

describe('RemoteDownloadProvider (production integration point)', () => {
  it('is unavailable until DOWNLOAD_SERVICE_URL is configured', async () => {
    const provider = new RemoteDownloadProvider();
    expect(provider.isConfigured(testEnv)).toBe(false);
    expect(provider.describe(testEnv).reason).toContain('DOWNLOAD_SERVICE_URL');
    await expect(
      buildSubmitRequest(
        {
          jobItemId: 'jit_1',
          jobId: 'job_1',
          seriesId: 'ser_1',
          seriesTitle: 'S',
          episodeId: 'ep_1',
          episodeIndex: 1,
          episodeTitle: 'E1',
          sourceUrl: 'https://watch.example.com/e/1',
          quality: '1080p',
          container: 'mp4',
          objectKey: 'vtgrab/s/S01E01-e1.mp4',
          filename: 'S01E01-e1.mp4',
          callbackOrigin: 'https://vtgrab.example.com',
        },
        testEnv,
      ),
    ).rejects.toThrow(/DOWNLOAD_SERVICE_URL is not configured/);

    // The default provider on an unconfigured deployment is an explicit error,
    // never a silent fallback to fake downloads.
    expect(() => resolveDownloadProvider({ ...testEnv, MOCK_ENABLED: 'false' } as Env)).toThrow(
      /No download provider is configured/,
    );
    expect(resolveDownloadProvider(testEnv).key).toBe('mock');
    expect(() => resolveDownloadProvider(testEnv, 'remote')).toThrow();
    expect(resolveExtractor(new URL('https://mock.local/x'), testEnv).key).toBe('mock');
  });

  it('submits a signed job to the download service', async () => {
    const env = remoteEnv();
    const request = {
      jobItemId: 'jit_1',
      jobId: 'job_1',
      seriesId: 'ser_1',
      seriesTitle: 'Series',
      episodeId: 'ep_1',
      episodeIndex: 3,
      episodeTitle: 'Episode 3',
      sourceUrl: 'https://watch.example.com/e/3',
      streamUrl: 'https://cdn.example.com/e/3/1080p.mp4',
      quality: '1080p',
      container: 'mp4',
      objectKey: 'vtgrab/series/S01E03-episode-3.mp4',
      filename: 'S01E03-episode-3.mp4',
      callbackOrigin: 'https://vtgrab.example.com',
    };

    const { url, init } = await buildSubmitRequest(request, env, 1_700_000_000_000);
    expect(url).toBe('https://downloads.example.com/v1/downloads');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer service-token');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-vtgrab-timestamp']).toBe('1700000000');
    expect(await verifySignature(SECRET, `1700000000.${init.body as string}`, headers['x-vtgrab-signature'])).toBe(
      true,
    );

    const body = JSON.parse(init.body as string) as {
      jobItemId: string;
      callbackUrl: string;
      objectKey: string;
      episode: { index: number; streamUrl: string };
    };
    expect(body.jobItemId).toBe('jit_1');
    expect(body.objectKey).toBe('vtgrab/series/S01E03-episode-3.mp4');
    expect(body.episode.index).toBe(3);
    expect(body.episode.streamUrl).toBe('https://cdn.example.com/e/3/1080p.mp4');

    const callback = new URL(body.callbackUrl);
    expect(callback.pathname).toBe('/api/internal/provider/callback/jit_1');
    const expires = Number(callback.searchParams.get('expires'));
    expect(expires - Math.floor(1_700_000_000_000 / 1000)).toBe(CALLBACK_TTL_SECONDS);
    expect(await verifySignature(SECRET, callbackPayload('jit_1', expires), callback.searchParams.get('sig'))).toBe(
      true,
    );
  });

  it('defers to the service, then streams the finished object into R2', async () => {
    const env = remoteEnv();
    const repo = new Repository(env);
    const seeded = await seedJob(1, 1);

    const job = (await repo.getJob(seeded.jobId)) as JobRecord;
    const item = (await repo.getJobItem(seeded.itemIds[0])) as JobItemRecord;
    const episode = (await repo.getEpisode(item.episodeId))!;
    const series = (await repo.getSeries(item.seriesId))!;

    const submitted: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(input as string, init);
      submitted.push(incoming.clone());
      const url = incoming.url;
      if (url.endsWith('/v1/downloads') && incoming.method === 'POST') {
        return new Response(JSON.stringify({ providerJobId: 'pj_1', status: 'queued' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v1/downloads/pj_1') && incoming.method === 'GET') {
        return new Response(JSON.stringify({ status: 'ready', downloadUrl: 'https://cdn.example.com/obj/1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://cdn.example.com/obj/1') {
        return new Response('real bytes from the authorized service', {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const provider = new RemoteDownloadProvider();
    const result = await provider.start(buildDownloadRequest(item, job, episode, series, 'https://vtgrab.example.com'), env);
    expect(result.kind).toBe('deferred');
    if (result.kind !== 'deferred') throw new Error('expected a deferred result');
    expect(result.providerRef).toBe('pj_1');
    expect(submitted[0].url).toBe('https://downloads.example.com/v1/downloads');

    await repo.updateJobItem(item.id, { status: 'downloading', providerRef: result.providerRef, provider: 'remote' });

    const status = await provider.status(result.providerRef, env);
    expect(status.status).toBe('ready');

    const { fetchRemoteObject } = await import('../worker/src/providers/download/remote');
    const object = await fetchRemoteObject(status.downloadUrl!, env);
    expect(object.contentType).toBe('video/mp4');

    await completeJobItemWithStream(env, repo, {
      item,
      stream: object.stream,
      contentType: object.contentType,
      contentLength: object.contentLength,
      providerKey: 'remote',
    });
    await finalizeJob(env, repo, job.id);

    const stored = await env.FILES.get(item.objectKey);
    expect(await stored!.text()).toBe('real bytes from the authorized service');

    const detail = await requestJson<JobDetail>(`/api/jobs/${seeded.jobId}`);
    expect(detail.job.status).toBe('completed');
    expect(detail.items[0].provider).toBe('remote');
    expect(detail.items[0].status).toBe('completed');
  });

  it('picks up finished deferred jobs during maintenance', async () => {
    const env = remoteEnv();
    const repo = new Repository(env);
    const seeded = await seedJob(1, 1);
    const item = (await repo.getJobItem(seeded.itemIds[0]))!;

    await repo.updateJobItem(item.id, {
      status: 'downloading',
      provider: 'remote',
      providerRef: 'pj_stale',
    });
    // Backdate the item so the maintenance sweep considers it stale.
    await env.DB.prepare(`UPDATE job_items SET updated_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 60 * 60 * 1000).toISOString(), item.id)
      .run();

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(input as string, init);
      if (incoming.method === 'GET' && incoming.url.includes('/v1/downloads/pj_stale')) {
        return new Response(
          JSON.stringify({ status: 'ready', downloadUrl: 'https://cdn.example.com/obj/2', bytes: 21 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (incoming.url === 'https://cdn.example.com/obj/2') {
        return new Response('maintenance streamed me', { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await runMaintenance(env, repo, 10);
    expect(result.polled).toBe(1);
    expect(result.completed).toBe(1);

    const after = await repo.getJobItem(item.id);
    expect(after?.status).toBe('completed');
    expect(await (await env.FILES.get(item.objectKey))!.text()).toBe('maintenance streamed me');
  });

  it('fails items whose remote job never finishes', async () => {
    const env = remoteEnv();
    const repo = new Repository(env);
    const seeded = await seedJob(1, 1);
    const item = (await repo.getJobItem(seeded.itemIds[0]))!;

    await repo.updateJobItem(item.id, { status: 'downloading', provider: 'remote', providerRef: 'pj_forever' });
    await env.DB.prepare(`UPDATE job_items SET updated_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), item.id)
      .run();

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ status: 'running', progress: 42 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await runMaintenance(env, repo, 10);
    expect(result.failed).toBe(1);
    const after = await repo.getJobItem(item.id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('still "running"');
  });
});
