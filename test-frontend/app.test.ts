import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountApp } from '../src/frontend/app';
import type { EpisodeRecord, SeriesRecord } from '../worker/src/shared/types';

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
    expect($('job-create-status').textContent).toContain('job job_1 created');
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
});
