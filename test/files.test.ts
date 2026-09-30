import { describe, expect, it } from 'vitest';
import { postJson, request, requestJson, testEnv, waitFor } from './helpers';
import type { EpisodeRecord, FileRecord, JobDetail, SeriesRecord } from '../worker/src/shared/types';

async function completedJob(): Promise<JobDetail> {
  const analyzed = (await (
    await postJson('/api/analyze', { url: `https://mock.local/series/files-${Date.now()}` })
  ).json()) as { series: SeriesRecord; episodes: EpisodeRecord[] };

  const created = (await (
    await postJson('/api/jobs', {
      seriesId: analyzed.series.id,
      selection: { mode: 'ids', episodeIds: [analyzed.episodes[0].id] },
      options: { prefix: 'files-test' },
    })
  ).json()) as JobDetail;

  await waitFor(`job ${created.job.id}`, async () => {
    const detail = await requestJson<JobDetail>(`/api/jobs/${created.job.id}`);
    return detail.job.status === 'completed';
  });
  return created;
}

describe('GET /api/files', () => {
  it('lists stored files and streams their content from R2', async () => {
    const job = await completedJob();
    const list = await requestJson<{ items: FileRecord[]; total: number }>('/api/files?limit=20');
    expect(list.total).toBeGreaterThan(0);

    const file = list.items.find((item) => item.jobId === job.job.id);
    expect(file).toBeDefined();
    expect(file!.size).toBeGreaterThan(0);
    expect(file!.objectKey.startsWith('files-test/')).toBe(true);

    const meta = await requestJson<{ file: FileRecord; downloadUrl: string }>(`/api/files/${file!.id}`);
    expect(meta.downloadUrl).toBe(`/api/files/${file!.id}/content`);

    const content = await request(`/api/files/${file!.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-length')).toBe(String(file!.size));
    expect(content.headers.get('accept-ranges')).toBe('bytes');
    expect(content.headers.get('content-disposition')).toContain('attachment');

    // The mock payload is binary, so compare bytes - not a UTF-8 string.
    const buffer = new Uint8Array(await content.arrayBuffer());
    expect(buffer.byteLength).toBe(file!.size);
    expect(new TextDecoder().decode(buffer.subarray(0, 35))).toBe('VTGrab MOCK OBJECT - NOT REAL MEDIA');
  });

  it('supports HTTP range requests', async () => {
    const job = await completedJob();
    const list = await requestJson<{ items: FileRecord[] }>(`/api/files?jobId=${job.job.id}`);
    const file = list.items[0];

    const response = await request(`/api/files/${file.id}/content`, {
      headers: { range: 'bytes=0-99' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-length')).toBe('100');
    expect(response.headers.get('content-range')).toBe(`bytes 0-99/${file.size}`);
    const chunk = await response.arrayBuffer();
    expect(chunk.byteLength).toBe(100);

    const suffix = await request(`/api/files/${file.id}/content`, {
      headers: { range: 'bytes=-50' },
    });
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(50);
  });

  it('returns 404 for unknown files', async () => {
    const response = await request('/api/files/fil_missing/content');
    expect(response.status).toBe(404);
  });

  it('deletes the R2 object together with the D1 row', async () => {
    const job = await completedJob();
    const list = await requestJson<{ items: FileRecord[] }>(`/api/files?jobId=${job.job.id}`);
    const file = list.items[0];

    const deleted = await request(`/api/files/${file.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(await testEnv.FILES.head(file.objectKey)).toBeNull();

    const after = await request(`/api/files/${file.id}`);
    expect(after.status).toBe(404);

    // The job item is released so it can be downloaded again.
    const detail = await requestJson<JobDetail>(`/api/jobs/${job.job.id}`);
    expect(detail.items[0].fileId).toBeNull();
    expect(detail.items[0].status).toBe('pending');
  });
});
