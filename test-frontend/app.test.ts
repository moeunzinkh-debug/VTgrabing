import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../src/frontend/app';
import type { EpisodeRecord, FileRecord, SeriesRecord } from '../src/shared/types';

const HTML = readFileSync(resolve(__dirname, '../src/frontend/index.html'), 'utf8');

const series: SeriesRecord = {
  id: 'ser_1',
  sourceKey: 'mock',
  sourceUrl: 'https://mock.local/series/1',
  canonicalUrl: 'mock:1',
  title: 'Test Series',
  synopsis: 'synopsis',
  posterUrl: null,
  episodeCount: 3,
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const episodes: EpisodeRecord[] = [1, 2, 3].map((index) => ({
  id: `ep_${index}`,
  seriesId: 'ser_1',
  episodeIndex: index,
  title: `Episode ${index}`,
  sourceUrl: `https://mock.local/e/${index}`,
  durationSeconds: 1400,
  thumbnailUrl: null,
  streams: [
    { quality: '1080p', container: 'mp4', bitrateKbps: 5000 },
    { quality: '720p', container: 'mp4', bitrateKbps: 2500 },
  ],
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}));

/** What the real grabber returns for one page: sizes/qualities read from the host. */
const grabbedSeries: SeriesRecord = {
  ...series,
  sourceKey: 'http-sniff',
  sourceUrl: 'http://127.0.0.1:8099/',
  canonicalUrl: 'grab:http://127.0.0.1:8099/',
  title: 'Big Buck Bunny - grabber fixture',
  episodeCount: 4,
  metadata: {
    diagnostics: ['opened http://127.0.0.1:8099/ (200, text/html)', 'probe: 4 candidate(s) confirmed'],
    crawledPages: ['/', '/ep/1'],
    videoCount: 4,
    encryptedCount: 1,
  },
};

const grabbedEpisodes: EpisodeRecord[] = [
  {
    id: 'ep_g1',
    seriesId: 'ser_1',
    episodeIndex: 1,
    title: 'Feature presentation',
    sourceUrl: 'http://127.0.0.1:8099/',
    durationSeconds: 600,
    thumbnailUrl: null,
    streams: [{ quality: '1080p', container: 'mp4', kind: 'progressive', sizeBytes: 7_826_953, url: 'http://127.0.0.1:8099/media/bunny.mp4' }],
    metadata: { grabbed: true },
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'ep_g2',
    seriesId: 'ser_1',
    episodeIndex: 2,
    title: 'Rabbit chase',
    sourceUrl: 'http://127.0.0.1:8099/',
    durationSeconds: 24,
    thumbnailUrl: null,
    streams: [
      { quality: '1080p', container: 'ts', kind: 'hls', segments: 4, sizeBytes: 635_154, url: 'http://127.0.0.1:8099/media/hls/master.m3u8' },
      { quality: '720p', container: 'ts', kind: 'hls', segments: 4, sizeBytes: 317_577, url: 'http://127.0.0.1:8099/media/hls/720p.m3u8' },
      { quality: '480p', container: 'ts', kind: 'hls', segments: 4, sizeBytes: 158_788, url: 'http://127.0.0.1:8099/media/hls/480p.m3u8' },
      { quality: '360p', container: 'ts', kind: 'hls', segments: 4, sizeBytes: 79_394, url: 'http://127.0.0.1:8099/media/hls/360p.m3u8' },
      { quality: '240p', container: 'ts', kind: 'hls', segments: 4, sizeBytes: 39_697, url: 'http://127.0.0.1:8099/media/hls/240p.m3u8' },
    ],
    metadata: { grabbed: true },
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'ep_g3',
    seriesId: 'ser_1',
    episodeIndex: 3,
    title: 'Backstage (protected)',
    sourceUrl: 'http://127.0.0.1:8099/',
    durationSeconds: 6,
    thumbnailUrl: null,
    streams: [{ quality: '1080p', container: 'ts', kind: 'hls', encrypted: true, url: 'http://127.0.0.1:8099/media/encrypted/master.m3u8' }],
    metadata: { grabbed: true, encrypted: true },
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'ep_g4',
    seriesId: 'ser_1',
    episodeIndex: 4,
    title: 'Premiere (live)',
    sourceUrl: 'http://127.0.0.1:8099/',
    durationSeconds: 6,
    thumbnailUrl: null,
    streams: [{ quality: 'source', container: 'ts', kind: 'hls', live: true, url: 'http://127.0.0.1:8099/media/live/media.m3u8' }],
    metadata: { grabbed: true, live: true },
    createdAt: '',
    updatedAt: '',
  },
];

const sources = {
  environment: 'test',
  time: '2026-01-01T00:00:00.000Z',
  bindings: { database: true, bucket: true, queue: true },
  extractors: [
    { key: 'mock', label: 'Mock catalog', kind: 'mock', available: true, configured: true },
    { key: 'authorized-http', label: 'Authorized', kind: 'authorized', available: false, configured: false },
  ],
  downloadProviders: [
    { key: 'remote', label: 'Remote', kind: 'remote', available: false, configured: false },
    { key: 'mock', label: 'Mock downloader', kind: 'mock', available: true, configured: true },
  ],
  limits: {
    maxAttempts: 3,
    defaultQuality: '1080p',
    defaultContainer: 'mp4',
    defaultConcurrency: 4,
    queuePushBatchSize: 100,
  },
};

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

const calls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch() {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/sources')) return jsonResponse(sources);
    if (url.startsWith('/api/analyze')) return jsonResponse({ series, episodes, extractor: 'mock', cached: false });
    if (url.startsWith('/api/jobs?')) return jsonResponse({ items: [], total: 0 });
    if (url.startsWith('/api/files?')) return jsonResponse({ items: [], total: 0 });
    if (url === '/api/jobs') {
      return jsonResponse(
        {
          job: { id: 'job_1', seriesId: 'ser_1', status: 'pending', totalItems: 2 },
          items: [],
          series: { id: 'ser_1', title: 'Test Series', sourceKey: 'mock', sourceUrl: '', posterUrl: null },
        },
        201,
      );
    }
    if (url.startsWith('/api/')) return jsonResponse({ error: { code: 'not_found', message: url } }, 404);
    return new Response('not found', { status: 404 });
  };
  vi.stubGlobal('fetch', impl);
}

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  }
}

beforeEach(() => {
  calls.length = 0;
  document.documentElement.innerHTML = HTML;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('VTGrab frontend', () => {
  it('boots, loads the backend status and renders the analyzed episode list', async () => {
    mountApp();
    await flush();

    expect(calls.some((call) => call.url === '/api/sources')).toBe(true);
    expect($('connection-text').textContent).toBe('backend online');
    expect($('env-badges').textContent).toContain('D1');

    const urlInput = $<HTMLInputElement>('analyze-url');
    urlInput.value = 'https://mock.local/series/1';
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const analyzeCall = calls.find((call) => call.url === '/api/analyze');
    expect(analyzeCall).toBeDefined();
    expect(JSON.parse(String(analyzeCall!.init?.body))).toEqual({
      url: 'https://mock.local/series/1',
      refresh: false,
      // "queue all found" is on by default: analyzing a link puts every video it
      // found into the download queue in the same request.
      queueAll: true,
    });

    expect($('series-card').hidden).toBe(false);
    expect($('episode-grid').querySelectorAll('.episode')).toHaveLength(3);
    expect($('series-header').textContent).toContain('Test Series');
    expect($('opt-quality').innerHTML).toContain('1080p');
  });

  it('selects and deselects episodes (checkbox, all, none, invert, range)', async () => {
    mountApp();
    await flush();

    $<HTMLInputElement>('analyze-url').value = 'https://mock.local/series/1';
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const boxes = () => Array.from($('episode-grid').querySelectorAll('input[type=checkbox]')) as HTMLInputElement[];

    // A finished analyze pre-selects everything it found; start from an empty set.
    expect($('selection-count').textContent).toBe('3 / 3 selected');
    $('deselect-all').click();
    await flush();

    // single click
    boxes()[1].click();
    await flush();
    expect($('selection-count').textContent).toBe('1 / 3 selected');
    expect($('download-selected').textContent).toBe('Download selected (1)');

    // shift-click extends the selection from the anchor
    boxes()[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await flush();
    expect($('selection-count').textContent).toBe('2 / 3 selected');

    $('select-all').click();
    await flush();
    expect($('selection-count').textContent).toBe('3 / 3 selected');
    expect(boxes().every((box) => box.checked)).toBe(true);

    $('deselect-all').click();
    await flush();
    expect($('selection-count').textContent).toBe('0 / 3 selected');
    expect(boxes().some((box) => box.checked)).toBe(false);

    boxes()[0].click();
    $('invert-selection').click();
    await flush();
    expect($('selection-count').textContent).toBe('2 / 3 selected');

    $<HTMLInputElement>('range-from').value = '2';
    $<HTMLInputElement>('range-to').value = '3';
    $('apply-range').click();
    await flush();
    expect($('selection-count').textContent).toBe('2 / 3 selected');
    expect(boxes()[0].checked).toBe(false);
    expect(boxes()[1].checked).toBe(true);
    expect(boxes()[2].checked).toBe(true);
  });

  it('posts a download job with the current selection and options', async () => {
    mountApp();
    await flush();

    $<HTMLInputElement>('analyze-url').value = 'https://mock.local/series/1';
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    $<HTMLInputElement>('range-from').value = '1';
    $<HTMLInputElement>('range-to').value = '2';
    $('apply-range').click();
    $<HTMLSelectElement>('opt-quality').value = '720p';
    $<HTMLInputElement>('opt-prefix').value = 'ui-test';
    await flush();

    $('download-selected').click();
    await flush();

    const jobCall = calls.find((call) => call.url === '/api/jobs');
    expect(jobCall).toBeDefined();
    const body = JSON.parse(String(jobCall!.init?.body));
    expect(body.seriesId).toBe('ser_1');
    expect(body.selection.mode).toBe('ids');
    expect(body.selection.episodeIds).toEqual(['ep_1', 'ep_2']);
    expect(body.options.quality).toBe('720p');
    expect(body.options.prefix).toBe('ui-test');
    expect($('job-create-status').textContent).toContain('job job_1 queued');
    expect($('analyze-result').textContent).toContain('not a saved video yet');
  });

  it('download-all sends mode "all" regardless of the checkbox selection', async () => {
    mountApp();
    await flush();

    $<HTMLInputElement>('analyze-url').value = 'https://mock.local/series/1';
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    $('download-all').click();
    await flush();

    const jobCall = calls.find((call) => call.url === '/api/jobs');
    expect(JSON.parse(String(jobCall!.init?.body)).selection).toEqual({ mode: 'all' });
  });

  it('surfaces API errors to the user', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/sources')) return jsonResponse(sources);
      if (url.startsWith('/api/analyze')) {
        return jsonResponse(
          { error: { code: 'unsupported_source', message: 'No extractor is able to handle that URL' } },
          422,
        );
      }
      return jsonResponse({ items: [], total: 0 });
    });

    mountApp();
    await flush();

    $<HTMLInputElement>('analyze-url').value = 'https://example.com/nope';
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const errorBox = $('analyze-error');
    expect(errorBox.hidden).toBe(false);
    expect(errorBox.textContent).toContain('No extractor is able to handle that URL');
    expect($('toasts').textContent).toContain('No extractor is able to handle that URL');
  });

  it('renders a grabbed listing honestly: real sizes, blocked sources, queued job', async () => {
    const grabbedJob = {
      job: { id: 'job_grab', seriesId: 'ser_1', status: 'pending', totalItems: 2, completedItems: 0, failedItems: 0, skippedItems: 0, bytes: 0, options: {}, createdAt: '', updatedAt: '', finishedAt: null },
      items: [],
      series: { id: 'ser_1', title: 'Big Buck Bunny', sourceKey: 'http-sniff', sourceUrl: '', posterUrl: null },
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('/api/sources')) return jsonResponse(sources);
      if (url.startsWith('/api/analyze')) {
        return jsonResponse({ series: grabbedSeries, episodes: grabbedEpisodes, extractor: 'http-sniff', cached: false, job: grabbedJob });
      }
      if (url.startsWith('/api/jobs?')) {
        return jsonResponse({ items: [{ ...grabbedJob.job, seriesTitle: 'Big Buck Bunny', bytes: 0 }], total: 1 });
      }
      if (url.startsWith('/api/files')) return jsonResponse({ items: [], total: 0 });
      return jsonResponse({ items: [], total: 0 });
    });

    mountApp();
    await flush();

    $<HTMLInputElement>('analyze-url').value = 'http://127.0.0.1:8099/';
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const grid = $('episode-grid');
    const boxes = () => Array.from(grid.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[];
    expect(grid.querySelectorAll('.episode')).toHaveLength(4);

    // sizes and qualities come from the grabbed streams, not from a fixed template
    expect(grid.textContent).toContain('7.46 MiB');
    expect(grid.textContent).toContain('1080p');
    expect(grid.textContent).toContain('HLS');
    expect(grid.textContent).toContain('+1 more');

    // the two videos that cannot become a file are listed but locked
    expect(grid.textContent).toContain('encrypted - not grabbable');
    expect(grid.textContent).toContain('live - not a file');
    expect(grid.querySelectorAll('.episode-blocked')).toHaveLength(2);
    expect(boxes()[2].disabled).toBe(true);
    expect(boxes()[3].disabled).toBe(true);

    // preselected = everything grabbable, i.e. 4 found minus the 2 blocked ones
    expect($('selection-count').textContent).toBe('2 / 4 selected');
    expect(boxes()[0].checked).toBe(true);
    expect(boxes()[1].checked).toBe(true);

    // the queue note and the diagnostics both explain what happened
    expect($('queue-note').textContent).toContain('1 encrypted');
    expect($('queue-note').textContent).toContain('1 live');
    expect($('analyze-diag').hidden).toBe(false);
    expect($('analyze-diag-text').textContent).toContain('probe: 4 candidate(s) confirmed');

    // Source playback is embedded on demand through the guarded Worker proxy.
    const preview = Array.from(grid.querySelectorAll('a')).find((link) => (link.getAttribute('href') ?? '').startsWith('/api/preview?url='));
    expect(preview?.getAttribute('href')).toContain(encodeURIComponent('http://127.0.0.1:8099/media/bunny.mp4'));
    const watchHere = grid.querySelector<HTMLButtonElement>('.preview-toggle');
    expect(watchHere?.textContent).toBe('Watch here');
    watchHere?.click();
    const sourcePlayer = grid.querySelector<HTMLVideoElement>('.episode-preview video');
    expect(sourcePlayer).not.toBeNull();
    expect(sourcePlayer?.getAttribute('src')).toContain('/api/preview?url=');
    expect(sourcePlayer?.getAttribute('src')).toContain(encodeURIComponent('http://127.0.0.1:8099/media/bunny.mp4'));
    expect($('analyze-result').textContent).toContain('not a saved video yet');

    // the job analyze created for us shows up in the jobs panel without a reload
    expect($('jobs-list').textContent).toContain('job_grab');
  });

  it('plays completed real downloads inline and clearly marks mock bytes as synthetic', async () => {
    const downloaded: FileRecord = {
      id: 'fil_video',
      jobId: 'job_video',
      jobItemId: 'item_video',
      seriesId: 'ser_1',
      episodeId: 'ep_1',
      bucket: 'FILES',
      objectKey: 'vtgrab/test/episode.mp4',
      filename: 'episode.mp4',
      contentType: 'video/mp4',
      size: 2048,
      etag: null,
      checksumSha256: null,
      quality: '1080p',
      container: 'mp4',
      durationSeconds: 12,
      provider: 'http-stream',
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const mockFile: FileRecord = {
      ...downloaded,
      id: 'fil_mock',
      objectKey: 'vtgrab/test/episode.mock.mp4',
      filename: 'episode.mock.mp4',
      contentType: 'application/octet-stream',
      provider: 'mock',
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/sources')) return jsonResponse(sources);
      if (url.startsWith('/api/jobs?')) return jsonResponse({ items: [], total: 0 });
      if (url.startsWith('/api/files?')) return jsonResponse({ items: [downloaded, mockFile], total: 2 });
      return jsonResponse({ items: [], total: 0 });
    });

    mountApp();
    await flush();

    const files = $('files-list');
    expect(files.textContent).toContain('mock · synthetic only');
    expect(files.textContent).toContain('not a real video');
    const play = files.querySelector<HTMLButtonElement>('.file-play');
    expect(play?.textContent).toBe('Play here');
    play?.click();

    const player = files.querySelector<HTMLVideoElement>('.file-preview video');
    expect(player).not.toBeNull();
    expect(player?.getAttribute('src')).toBe('/api/files/fil_video/content?inline=1');
    expect(files.querySelector('.file-preview-row')?.hasAttribute('hidden')).toBe(false);
  });

  it('shows the TikTok verdict, episode numbers and a list-only episode list', async () => {
    const tiktokSeries: SeriesRecord = {
      ...series,
      sourceKey: 'tiktok',
      sourceUrl: 'https://vm.tiktok.com/ZM1/',
      canonicalUrl: 'tiktok:playlist:1',
      title: 'Secret Wife',
      episodeCount: 2,
      metadata: {
        contentKind: 'mini-drama',
        confidence: 'high',
        signals: ['drama hashtag: #minidrama', 'video belongs to a playlist'],
        currentEpisodeNumber: 12,
        totalEpisodes: 60,
        listNote: 'The public page lists 2 of 60 episodes.',
        resolvedUrl: 'https://www.tiktok.com/@a/video/12',
      },
    };
    const tiktokEpisodes: EpisodeRecord[] = [11, 12].map((n, i) => ({
      ...episodes[0],
      id: `tt_${n}`,
      episodeIndex: i + 1,
      title: 'Secret Wife',
      sourceUrl: `https://www.tiktok.com/@a/video/${n}`,
      streams: [],
      metadata: { listOnly: true, episodeNumber: n, current: n === 12 },
    }));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/sources')) return jsonResponse(sources);
      if (url.startsWith('/api/analyze')) {
        return jsonResponse({ series: tiktokSeries, episodes: tiktokEpisodes, extractor: 'tiktok', cached: false });
      }
      return jsonResponse({ items: [], total: 0 });
    });
    mountApp();
    await flush();
    $<HTMLInputElement>('analyze-url').value = 'https://vm.tiktok.com/ZM1/';
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const header = $('series-header').textContent ?? '';
    expect(header).toContain('Mini-drama');
    expect(header).toContain('high confidence');
    expect(header).toContain('this link: EP 12 / 60');
    expect(header).toContain('Why: drama hashtag');
    expect(header).toContain('lists 2 of 60');
    expect(header).toContain('resolved: https://www.tiktok.com/@a/video/12');

    const grid = $('episode-grid');
    expect(grid.textContent).toContain('EP 11');
    expect(grid.textContent).toContain('EP 12');
    expect(grid.textContent).toContain('your link');
    expect(grid.textContent).toContain('listed only');
    expect(grid.querySelectorAll('.episode-listed')).toHaveLength(2);
    expect($('selection-count').textContent).toBe('0 / 2 selected');
    expect($('queue-note').textContent).toContain('listed for reference only');
  });

  it('requires rights/third-party consent before using the optional SSSTik provider', async () => {
    const tiktokSeries: SeriesRecord = {
      ...series,
      sourceKey: 'tiktok',
      title: 'Authorized TikTok posts',
      metadata: { platform: 'tiktok' },
    };
    const tiktokEpisodes: EpisodeRecord[] = [1, 2].map((n) => ({
      ...episodes[0],
      id: `ssstik_${n}`,
      episodeIndex: n,
      title: `TikTok post ${n}`,
      sourceUrl: `https://www.tiktok.com/@creator/video/123456789012345678${n}`,
      streams: [],
      metadata: { platform: 'tiktok', listOnly: true },
    }));
    const providerSources = {
      ...sources,
      downloadProviders: [
        ...sources.downloadProviders,
        {
          key: 'tiktok-ssstik',
          label: 'TikTok via SSSTik (unofficial third party; opt-in)',
          kind: 'http',
          available: true,
          configured: true,
        },
      ],
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('/api/sources')) return jsonResponse(providerSources);
      if (url.startsWith('/api/analyze')) {
        return jsonResponse({ series: tiktokSeries, episodes: tiktokEpisodes, extractor: 'tiktok', cached: false });
      }
      if (url === '/api/jobs') {
        return jsonResponse(
          {
            job: { id: 'job_tiktok', seriesId: tiktokSeries.id, status: 'pending', totalItems: 2 },
            items: [],
            series: { id: tiktokSeries.id, title: tiktokSeries.title, sourceKey: 'tiktok', sourceUrl: '', posterUrl: null },
          },
          201,
        );
      }
      return jsonResponse({ items: [], total: 0 });
    });

    mountApp();
    await flush();
    $<HTMLInputElement>('analyze-url').value = tiktokSeries.sourceUrl;
    $('analyze-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const provider = $<HTMLSelectElement>('opt-provider');
    provider.value = 'tiktok-ssstik';
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect($('third-party-warning').hidden).toBe(false);
    expect($('selection-count').textContent).toBe('2 / 2 selected');

    $('download-all').click();
    await flush();
    expect(calls.some((call) => call.url === '/api/jobs')).toBe(false);
    expect($('job-create-status').textContent).toContain('Confirm rights');

    $<HTMLInputElement>('third-party-consent').checked = true;
    $('download-all').click();
    await flush();
    const jobCall = calls.find((call) => call.url === '/api/jobs');
    expect(jobCall).toBeDefined();
    const body = JSON.parse(String(jobCall!.init?.body));
    expect(body.selection).toEqual({ mode: 'all' });
    expect(body.options.provider).toBe('tiktok-ssstik');
    expect(body.options.thirdPartyConsent).toBe(true);
  });

});
