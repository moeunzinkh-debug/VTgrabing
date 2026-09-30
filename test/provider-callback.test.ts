import { describe, expect, it } from 'vitest';
import { hmacHex, callbackPayload } from '../worker/src/providers/signature';
import { request, requestJson, seedJob, testEnv } from './helpers';
import type { FileRecord, JobDetail } from '../worker/src/shared/types';

const SECRET = 'test-callback-secret';

async function callbackUrl(jobItemId: string, ttlSeconds = 3600): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await hmacHex(SECRET, callbackPayload(jobItemId, expires));
  return `/api/internal/provider/callback/${jobItemId}?expires=${expires}&sig=sha256%3D${signature}`;
}

describe('PUT /api/internal/provider/callback/:jobItemId', () => {
  it('stores the object pushed by an authorized download service', async () => {
    const seeded = await seedJob(1, 1);
    const jobItemId = seeded.itemIds[0];
    const bytes = new TextEncoder().encode('remote provider payload for the callback test');

    const response = await request(await callbackUrl(jobItemId), {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-vtgrab-ref': 'provider-job-42' },
      body: bytes,
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { ok: boolean; fileId: string; size: number };
    expect(body.ok).toBe(true);
    expect(body.size).toBe(bytes.byteLength);

    const stored = await testEnv.FILES.get(seeded.objectKeys[0]);
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe('remote provider payload for the callback test');

    const detail = await requestJson<JobDetail>(`/api/jobs/${seeded.jobId}`);
    const item = detail.items[0];
    expect(item.status).toBe('completed');
    expect(item.providerRef).toBe('provider-job-42');
    expect(item.bytes).toBe(bytes.byteLength);
    expect(detail.job.status).toBe('completed');

    const files = await requestJson<{ items: FileRecord[] }>(`/api/files?jobId=${seeded.jobId}`);
    expect(files.items).toHaveLength(1);
    expect(files.items[0].provider).toBe('remote');
  });

  it('is idempotent when the service retries the callback', async () => {
    const seeded = await seedJob(1, 1);
    const url = await callbackUrl(seeded.itemIds[0]);
    const first = await request(url, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    expect(first.status).toBe(201);
    const second = await request(url, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    expect(second.status).toBe(201);

    const files = await requestJson<{ items: FileRecord[] }>(`/api/files?jobId=${seeded.jobId}`);
    expect(files.items).toHaveLength(1);
  });

  it('rejects invalid or expired signatures', async () => {
    const seeded = await seedJob(1, 1);
    const jobItemId = seeded.itemIds[0];

    const badSignature = await request(
      `/api/internal/provider/callback/${jobItemId}?expires=${
        Math.floor(Date.now() / 1000) + 600
      }&sig=sha256%3Ddeadbeef`,
      { method: 'PUT', body: new Uint8Array([1]) },
    );
    expect(badSignature.status).toBe(401);

    const missing = await request(
      `/api/internal/provider/callback/${jobItemId}?expires=${Math.floor(Date.now() / 1000) + 600}`,
      { method: 'PUT', body: new Uint8Array([1]) },
    );
    expect(missing.status).toBe(401);

    const expired = await request(await callbackUrl(jobItemId, -60), {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    expect(expired.status).toBe(401);
  });

  it('rejects unknown job items', async () => {
    const response = await request(await callbackUrl('jit_nope'), {
      method: 'PUT',
      body: new Uint8Array([1]),
    });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/internal/maintenance', () => {
  it('requires the shared secret', async () => {
    const anonymous = await request('/api/internal/maintenance', { method: 'POST' });
    expect(anonymous.status).toBe(401);

    const wrong = await request('/api/internal/maintenance', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
  });

  it('reports what the cron would do', async () => {
    const response = await request('/api/internal/maintenance?limit=10', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { polled: number; completed: number; failed: number };
    expect(body).toEqual({ polled: 0, completed: 0, failed: 0 });
  });
});
