import type {
  EpisodeRecord,
  FileRecord,
  JobDetail,
  JobListItem,
  JobOptions,
  SelectionDescriptor,
  SeriesRecord,
  SystemStatus,
} from '../shared/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    throw new ApiError(0, 'network_error', `Cannot reach the Worker API (${(error as Error).message})`);
  }

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'http_error',
      body?.error?.message ?? `Request failed with ${response.status}`,
      body?.error?.details,
    );
  }
  return payload as T;
}

export interface AnalyzeResponse {
  series: SeriesRecord;
  episodes: EpisodeRecord[];
  extractor: string;
  cached: boolean;
  /** Present when the analyze request also queued the found videos. */
  job?: JobDetail;
}

export const api = {
  health: () => request<{ ok: boolean; environment: string; mocks: boolean }>('/api/health'),

  sources: () => request<SystemStatus>('/api/sources'),

  providers: () =>
    request<{
      defaultProvider: string | null;
      extractors: SystemStatus['extractors'];
      downloadProviders: SystemStatus['downloadProviders'];
    }>('/api/providers'),

  listSeries: (query: { q?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set('q', query.q);
    params.set('limit', String(query.limit ?? 20));
    return request<{ items: SeriesRecord[]; total: number }>(`/api/series?${params.toString()}`);
  },

  getSeries: (id: string) =>
    request<{ series: SeriesRecord; episodes: EpisodeRecord[] }>(`/api/series/${encodeURIComponent(id)}`),

  /**
   * Open `url` on the server, find every video source on it and store the result.
   * With `queueAll` the server also creates the download job in the same request,
   * so one click puts every found video into the queue.
   */
  analyze: (url: string, sourceKey?: string, refresh = false, queueAll = false) =>
    request<AnalyzeResponse>('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ url, ...(sourceKey ? { sourceKey } : {}), refresh, queueAll }),
    }),

  createJob: (seriesId: string, selection: SelectionDescriptor, options?: Partial<JobOptions>) =>
    request<JobDetail>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ seriesId, selection, ...(options ? { options } : {}) }),
    }),

  listJobs: (query: { status?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    params.set('limit', String(query.limit ?? 30));
    return request<{ items: JobListItem[]; total: number }>(`/api/jobs?${params.toString()}`);
  },

  getJob: (id: string) => request<JobDetail>(`/api/jobs/${encodeURIComponent(id)}`),

  jobEvents: (id: string) =>
    request<{ events: Array<{ id: number; message: string; level: string; createdAt: string }> }>(
      `/api/jobs/${encodeURIComponent(id)}/events?limit=50`,
    ),

  cancelJob: (id: string) =>
    request<JobDetail>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),

  retryJob: (id: string) =>
    request<JobDetail>(`/api/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  listFiles: (limit = 30) =>
    request<{ items: FileRecord[]; total: number }>(`/api/files?limit=${limit}`),

  deleteFile: (id: string) =>
    request<null>(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  fileDownloadUrl: (id: string) => `/api/files/${encodeURIComponent(id)}/content`,
};
