import './styles.css';
import { api, ApiError } from './api';
import { episodeLabel } from '../core/ids';
import { normalizeRange, rangeIdsBetween } from '../core/selection';
import type {
  EpisodeRecord,
  FileRecord,
  JobDetail,
  JobListItem,
  JobStatus,
  ProviderDescriptor,
  SeriesRecord,
  SystemStatus,
} from '../shared/types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface AppState {
  status: SystemStatus | null;
  online: boolean;
  series: SeriesRecord | null;
  episodes: EpisodeRecord[];
  selected: Set<string>;
  anchorIndex: number | null;
  jobs: JobListItem[];
  details: Map<string, JobDetail>;
  events: Map<string, Array<{ id: number; message: string; level: string; createdAt: string }>>;
  files: FileRecord[];
  expanded: Set<string>;
  showEvents: Set<string>;
  analyzing: boolean;
  creating: boolean;
  selectionMode: 'ids' | 'range' | 'all';
}

const state: AppState = {
  status: null,
  online: false,
  series: null,
  episodes: [],
  selected: new Set<string>(),
  anchorIndex: null,
  jobs: [],
  details: new Map(),
  events: new Map(),
  files: [],
  expanded: new Set(),
  showEvents: new Set(),
  analyzing: false,
  creating: false,
  selectionMode: 'ids',
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '--:--';
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  const container = $('toasts');
  const node = el('div', `toast toast-${kind}`, message);
  container.appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Top bar / status
// ---------------------------------------------------------------------------

function renderStatus(): void {
  const badges = $('env-badges');
  clear(badges);
  if (state.status) {
    badges.appendChild(chip(state.status.environment, 'ok'));
    badges.appendChild(
      chip(state.status.bindings.database ? 'D1' : 'D1 missing', state.status.bindings.database ? 'ok' : 'error'),
    );
    badges.appendChild(
      chip(state.status.bindings.bucket ? 'R2' : 'R2 missing', state.status.bindings.bucket ? 'ok' : 'error'),
    );
    badges.appendChild(
      chip(state.status.bindings.queue ? 'Queues' : 'Queues missing', state.status.bindings.queue ? 'ok' : 'error'),
    );
  }

  const providers = state.status?.downloadProviders ?? [];
  const anyAvailable = providers.some((provider) => provider.available);
  for (const provider of providers) {
    const providerChip = chip(
      `${provider.kind === 'mock' ? 'mock' : 'remote'}: ${provider.key}${provider.available ? '' : ' (off)'}`,
      provider.available ? 'ok' : anyAvailable ? 'muted' : 'error',
    );
    providerChip.title = provider.reason ?? '';
    badges.appendChild(providerChip);
  }

  const connection = $('connection');
  connection.classList.toggle('online', state.online);
  $('connection-text').textContent = state.online ? 'backend online' : 'backend unreachable';
}

function chip(text: string, kind: 'ok' | 'warn' | 'error' | 'muted'): HTMLElement {
  return el('span', `chip chip-${kind}`, text);
}

function renderSourceOptions(): void {
  const select = $<HTMLSelectElement>('analyze-source');
  clear(select);
  const auto = el('option', undefined, 'auto detect');
  auto.value = '';
  select.appendChild(auto);
  for (const extractor of state.status?.extractors ?? []) {
    const option = el('option', undefined, `${extractor.label}${extractor.available ? '' : ' (unavailable)'}`);
    option.value = extractor.key;
    if (!extractor.available) option.disabled = true;
    select.appendChild(option);
  }

  const providerSelect = $<HTMLSelectElement>('opt-provider');
  clear(providerSelect);
  const defaultOption = el('option', undefined, 'auto (default)');
  defaultOption.value = '';
  providerSelect.appendChild(defaultOption);
  for (const provider of state.status?.downloadProviders ?? []) {
    const option = el('option', undefined, `${provider.label}${provider.available ? '' : ' (unavailable)'}`);
    option.value = provider.key;
    if (!provider.available) option.disabled = true;
    providerSelect.appendChild(option);
  }

  const filter = $<HTMLSelectElement>('jobs-filter');
  if (filter.options.length <= 1) {
    for (const status of ['pending', 'running', 'completed', 'failed', 'cancelled', 'partial']) {
      const option = el('option', undefined, status);
      option.value = status;
      filter.appendChild(option);
    }
  }
}

function renderHint(): void {
  const hint = $('analyze-hint');
  const available: ProviderDescriptor[] = (state.status?.extractors ?? []).filter((item) => item.available);
  if (available.length === 0) {
    hint.textContent =
      'No extractor is configured. Set SOURCE_API_BASE_URL + SOURCE_API_TOKEN for an authorized catalog, or MOCK_ENABLED=true for local development.';
    hint.classList.add('warn-text');
    return;
  }
  hint.classList.remove('warn-text');
  hint.textContent = available
    .map((item) => `${item.key}: ${item.reason ?? item.label}`)
    .join(' • ');
}

// ---------------------------------------------------------------------------
// Series + episode selection
// ---------------------------------------------------------------------------

function renderSeries(): void {
  const card = $('series-card');
  const jobCard = $('job-card');
  if (!state.series) {
    card.hidden = true;
    jobCard.hidden = true;
    return;
  }
  card.hidden = false;
  jobCard.hidden = false;

  const header = $('series-header');
  clear(header);
  const title = el('h3', undefined, state.series.title);
  header.appendChild(title);
  const meta = el(
    'p',
    'muted',
    `${state.series.episodeCount} episodes • source: ${state.series.sourceKey} • updated ${formatTime(
      state.series.updatedAt,
    )}`,
  );
  header.appendChild(meta);
  if (state.series.synopsis) header.appendChild(el('p', 'synopsis', state.series.synopsis));
  header.appendChild(el('p', 'muted small', state.series.sourceUrl));

  const rangeFrom = $<HTMLInputElement>('range-from');
  const rangeTo = $<HTMLInputElement>('range-to');
  rangeTo.max = String(state.episodes.length);
  rangeFrom.max = String(state.episodes.length);
  if (state.episodes.length > 0 && Number(rangeTo.value) === 1) {
    rangeTo.value = String(state.episodes.length);
  }

  renderQualityOptions();
  renderEpisodes();
  renderSelectionCount();
}

function renderQualityOptions(): void {
  const select = $<HTMLSelectElement>('opt-quality');
  const previous = select.value;
  const qualities = new Set<string>();
  for (const episode of state.episodes) {
    for (const stream of episode.streams) qualities.add(stream.quality);
  }
  const ordered = [...qualities].sort((a, b) => {
    const left = Number.parseInt(a, 10);
    const right = Number.parseInt(b, 10);
    if (Number.isFinite(left) && Number.isFinite(right)) return right - left;
    return a.localeCompare(b);
  });
  clear(select);
  for (const quality of ordered.length > 0 ? ordered : ['1080p', '720p', '480p']) {
    const option = el('option', undefined, quality);
    option.value = quality;
    select.appendChild(option);
  }
  if (previous && ordered.includes(previous)) select.value = previous;
  else if (state.status) select.value = state.status.limits.defaultQuality;

  const containers = new Set<string>();
  for (const episode of state.episodes) {
    for (const stream of episode.streams) containers.add(stream.container);
  }
  if (containers.size > 0) {
    $<HTMLInputElement>('opt-container').value = [...containers][0];
  }
}

function renderEpisodes(): void {
  const grid = $('episode-grid');
  clear(grid);

  for (const episode of state.episodes) {
    const item = el('label', 'episode');
    const checkbox = el('input') as HTMLInputElement;
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(episode.id);
    checkbox.dataset.episodeId = episode.id;
    checkbox.dataset.episodeIndex = String(episode.episodeIndex);
    checkbox.addEventListener('click', onEpisodeClick);

    const body = el('div', 'episode-body');
    body.appendChild(el('span', 'episode-index', episodeLabel(episode.episodeIndex)));
    body.appendChild(el('span', 'episode-title', episode.title));
    const meta = el('div', 'episode-meta');
    meta.appendChild(el('span', undefined, formatDuration(episode.durationSeconds)));
    for (const stream of episode.streams.slice(0, 3)) {
      meta.appendChild(el('span', 'chip chip-muted', stream.quality));
    }
    body.appendChild(meta);

    item.appendChild(checkbox);
    item.appendChild(body);
    grid.appendChild(item);
  }
}

function onEpisodeClick(event: MouseEvent): void {
  const checkbox = event.currentTarget as HTMLInputElement;
  const episodeId = checkbox.dataset.episodeId!;
  const index = Number.parseInt(checkbox.dataset.episodeIndex ?? '0', 10);

  if (event.shiftKey && state.anchorIndex !== null) {
    const ids = rangeIdsBetween(state.episodes, state.anchorIndex, index);
    for (const id of ids) state.selected.add(id);
    state.selectionMode = 'range';
  } else {
    state.selectionMode = 'ids';
    if (state.selected.has(episodeId)) state.selected.delete(episodeId);
    else state.selected.add(episodeId);
  }
  state.anchorIndex = index;
  renderEpisodes();
  renderSelectionCount();
}

function renderSelectionCount(): void {
  const count = state.selected.size;
  $('selection-count').textContent = `${count} / ${state.episodes.length} selected`;
  $<HTMLButtonElement>('download-selected').textContent = `Download selected (${count})`;
  $<HTMLButtonElement>('download-all').textContent = `Download all (${state.episodes.length})`;
  $<HTMLButtonElement>('download-selected').disabled = count === 0 || state.creating;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  partial: 'partial',
};

function statusClass(status: string): string {
  return `status-${status}`;
}

function renderJobs(): void {
  const list = $('jobs-list');
  clear(list);

  if (state.jobs.length === 0) {
    list.appendChild(el('p', 'muted', 'No jobs yet. Select episodes and create a download job.'));
    return;
  }

  for (const job of state.jobs) {
    list.appendChild(renderJob(job));
  }
}

function renderJob(job: JobListItem): HTMLElement {
  const card = el('div', 'job');
  const detail = state.details.get(job.id);
  const items = detail?.items ?? [];

  const header = el('div', 'job-header');
  const titleWrap = el('div', 'job-title');
  titleWrap.appendChild(el('h4', undefined, job.seriesTitle ?? job.seriesId));
  titleWrap.appendChild(
    el(
      'p',
      'muted small',
      `${job.id} • created ${formatTime(job.createdAt)} • finished ${formatTime(job.finishedAt)}`,
    ),
  );
  header.appendChild(titleWrap);

  const badges = el('div', 'job-badges');
  badges.appendChild(el('span', `badge ${statusClass(job.status)}`, STATUS_LABEL[job.status] ?? job.status));
  badges.appendChild(
    el(
      'span',
      'badge muted',
      `${job.completedItems}/${job.totalItems} done${job.failedItems ? ` • ${job.failedItems} failed` : ''}${
        job.cancelledItems ? ` • ${job.cancelledItems} cancelled` : ''
      }`,
    ),
  );
  badges.appendChild(el('span', 'badge muted', formatBytes(job.bytes)));
  header.appendChild(badges);

  const actions = el('div', 'job-actions');
  const toggle = el('button', undefined, state.expanded.has(job.id) ? 'Hide details' : 'Show details');
  toggle.addEventListener('click', () => {
    if (state.expanded.has(job.id)) state.expanded.delete(job.id);
    else {
      state.expanded.add(job.id);
      void loadJobDetail(job.id);
    }
    renderJobs();
  });
  actions.appendChild(toggle);

  const cancel = el('button', undefined, 'Cancel');
  cancel.disabled = job.status === 'completed' || job.status === 'cancelled';
  cancel.addEventListener('click', () => void runCancel(job.id));
  actions.appendChild(cancel);

  const retry = el('button', undefined, 'Retry failed');
  retry.disabled = job.status === 'running' || job.status === 'pending';
  retry.addEventListener('click', () => void runRetry(job.id));
  actions.appendChild(retry);

  header.appendChild(actions);
  card.appendChild(header);

  const total = Math.max(1, job.totalItems);
  const done = job.completedItems / total;
  const failed = job.failedItems / total;
  const cancelled = job.cancelledItems / total;
  const bar = el('div', 'progress');
  if (done > 0) bar.appendChild(el('div', 'progress-fill done', '')).style.width = `${done * 100}%`;
  if (failed > 0) bar.appendChild(el('div', 'progress-fill failed', '')).style.width = `${failed * 100}%`;
  if (cancelled > 0) bar.appendChild(el('div', 'progress-fill cancelled', '')).style.width = `${cancelled * 100}%`;
  card.appendChild(bar);

  if (job.error) card.appendChild(el('p', 'error small', job.error));

  if (state.expanded.has(job.id)) {
    const itemList = el('div', 'job-items');
    if (items.length === 0) {
      itemList.appendChild(el('p', 'muted small', 'Loading job items…'));
    }
    for (const item of items) {
      const row = el('div', `job-item ${statusClass(item.status)}`);
      row.appendChild(el('span', 'item-index', episodeLabel(item.episodeIndex)));
      row.appendChild(el('span', 'item-title', item.episodeTitle));
      row.appendChild(el('span', `badge ${statusClass(item.status)}`, item.status));
      row.appendChild(el('span', 'muted small', `${item.progress}%`));
      row.appendChild(el('span', 'muted small', formatBytes(item.bytes)));
      if (item.fileId) {
        const link = el('a', 'link', 'download') as HTMLAnchorElement;
        link.href = api.fileDownloadUrl(item.fileId);
        link.rel = 'noopener';
        row.appendChild(link);
      }
      if (item.error) row.appendChild(el('span', 'error small', item.error));
      itemList.appendChild(row);
    }
    card.appendChild(itemList);

    const eventsToggle = el('button', 'link-button', state.showEvents.has(job.id) ? 'Hide activity' : 'Show activity');
    eventsToggle.addEventListener('click', () => {
      if (state.showEvents.has(job.id)) state.showEvents.delete(job.id);
      else {
        state.showEvents.add(job.id);
        void loadJobEvents(job.id);
      }
      renderJobs();
    });
    card.appendChild(eventsToggle);

    if (state.showEvents.has(job.id)) {
      const eventList = el('div', 'job-events');
      for (const event of state.events.get(job.id) ?? []) {
        const row = el('div', `event event-${event.level}`);
        row.appendChild(el('span', 'muted small', formatTime(event.createdAt)));
        row.appendChild(el('span', undefined, event.message));
        eventList.appendChild(row);
      }
      card.appendChild(eventList);
    }
  }

  return card;
}

function renderFiles(): void {
  const list = $('files-list');
  clear(list);
  if (state.files.length === 0) {
    list.appendChild(el('p', 'muted', 'No files stored in R2 yet.'));
    return;
  }
  const table = el('table', 'files-table');
  const head = el('tr');
  for (const label of ['File', 'Size', 'Quality', 'Provider', 'Stored', '']) {
    head.appendChild(el('th', undefined, label));
  }
  table.appendChild(head);

  for (const file of state.files) {
    const row = el('tr');
    row.appendChild(el('td', 'filename', file.filename));
    row.appendChild(el('td', undefined, formatBytes(file.size)));
    row.appendChild(el('td', undefined, file.quality ?? '—'));
    row.appendChild(el('td', undefined, file.provider));
    row.appendChild(el('td', 'muted small', formatTime(file.createdAt)));
    const actions = el('td');
    const link = el('a', 'link', 'download') as HTMLAnchorElement;
    link.href = api.fileDownloadUrl(file.id);
    actions.appendChild(link);
    const remove = el('button', 'link-button danger', 'delete');
    remove.addEventListener('click', () => void runDeleteFile(file.id));
    actions.appendChild(remove);
    row.appendChild(actions);
    table.appendChild(row);
  }
  list.appendChild(table);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function runAnalyze(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  let url = $<HTMLInputElement>('analyze-url').value.trim();
  if (url && !/^https?:\/\//i.test(url) && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(url)) {
    url = `https://${url}`;
    $<HTMLInputElement>('analyze-url').value = url;
  }
  const sourceKey = $<HTMLSelectElement>('analyze-source').value || undefined;
  const refresh = $<HTMLInputElement>('analyze-refresh').checked;

  const errorBox = $('analyze-error');
  errorBox.hidden = true;
  if (!url) return;

  state.analyzing = true;
  $<HTMLButtonElement>('analyze-submit').disabled = true;

  try {
    const result = await api.analyze(url, sourceKey, refresh);
    state.series = result.series;
    state.episodes = result.episodes;
    state.selected = new Set<string>();
    state.anchorIndex = null;
    state.selectionMode = 'ids';
    renderSeries();
    toast(
      `Analyzed ${result.episodes.length} episodes with ${result.extractor}${result.cached ? ' (cached)' : ''}`,
      'success',
    );
  } catch (error) {
    showError(errorBox, error);
  } finally {
    state.analyzing = false;
    $<HTMLButtonElement>('analyze-submit').disabled = false;
  }
}

function showError(node: HTMLElement, error: unknown): void {
  const message = error instanceof ApiError ? error.message : (error as Error).message;
  node.textContent = message;
  node.hidden = false;
  toast(message, 'error');
}

async function runCreateJob(mode: 'ids' | 'all'): Promise<void> {
  if (!state.series) return;
  const seriesId = state.series.id;
  const ids =
    mode === 'all' ? state.episodes.map((episode) => episode.id) : [...state.selected];
  if (ids.length === 0) {
    toast('Select at least one episode first', 'error');
    return;
  }

  state.creating = true;
  $<HTMLButtonElement>('download-selected').disabled = true;
  $<HTMLButtonElement>('download-all').disabled = true;
  const status = $('job-create-status');
  status.textContent = 'creating job…';

  const options = {
    quality: $<HTMLSelectElement>('opt-quality').value,
    container: $<HTMLInputElement>('opt-container').value.trim() || 'mp4',
    concurrency: Number.parseInt($<HTMLInputElement>('opt-concurrency').value, 10) || 4,
    prefix: $<HTMLInputElement>('opt-prefix').value.trim() || 'vtgrab',
  };
  const provider = $<HTMLSelectElement>('opt-provider').value;
  if (provider) Object.assign(options, { provider });

  try {
    const detail = await api.createJob(
      seriesId,
      mode === 'all' ? { mode: 'all' } : { mode: 'ids', episodeIds: ids },
      options,
    );
    state.details.set(detail.job.id, detail);
    state.expanded.add(detail.job.id);
    status.textContent = `job ${detail.job.id} created (${detail.items.length} items)`;
    toast(`Created job with ${detail.items.length} item(s)`, 'success');
    await Promise.all([refreshJobs(), refreshFiles()]);
  } catch (error) {
    status.textContent = '';
    showError($('analyze-error'), error);
  } finally {
    state.creating = false;
    $<HTMLButtonElement>('download-all').disabled = false;
    renderSelectionCount();
  }
}

async function runCancel(jobId: string): Promise<void> {
  try {
    const detail = await api.cancelJob(jobId);
    state.details.set(jobId, detail);
    toast(`Job ${jobId} cancelled`, 'info');
    await refreshJobs();
  } catch (error) {
    showError($('analyze-error'), error);
  }
}

async function runRetry(jobId: string): Promise<void> {
  try {
    const detail = await api.retryJob(jobId);
    state.details.set(jobId, detail);
    toast(`Re-queued failed items of ${jobId}`, 'info');
    await refreshJobs();
  } catch (error) {
    showError($('analyze-error'), error);
  }
}

async function runDeleteFile(fileId: string): Promise<void> {
  try {
    await api.deleteFile(fileId);
    await refreshFiles();
    toast('File deleted from R2 and D1', 'info');
  } catch (error) {
    showError($('analyze-error'), error);
  }
}

function applyRange(): void {
  const from = Number.parseInt($<HTMLInputElement>('range-from').value, 10) || 1;
  const to = Number.parseInt($<HTMLInputElement>('range-to').value, 10) || from;
  const range = normalizeRange(from, to);
  state.selected = new Set(
    state.episodes
      .filter((episode) => episode.episodeIndex >= range.from && episode.episodeIndex <= range.to)
      .map((episode) => episode.id),
  );
  state.selectionMode = 'range';
  renderEpisodes();
  renderSelectionCount();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  try {
    state.status = await api.sources();
    state.online = true;
  } catch (error) {
    state.online = false;
    console.error(error);
  }
  renderStatus();
  renderSourceOptions();
  renderHint();
}

async function refreshJobs(): Promise<void> {
  const filter = $<HTMLSelectElement>('jobs-filter').value;
  try {
    const result = await api.listJobs({ status: filter || undefined });
    state.jobs = result.items;
    state.online = true;
  } catch (error) {
    console.error(error);
    state.online = false;
  }
  await Promise.all(
    state.jobs
      .filter((job) => state.expanded.has(job.id))
      .map(async (job) => {
        await loadJobDetail(job.id);
      }),
  );
  renderJobs();
  renderStatus();
}

async function loadJobDetail(jobId: string): Promise<void> {
  try {
    const detail = await api.getJob(jobId);
    state.details.set(jobId, detail);
    if (state.showEvents.has(jobId)) await loadJobEvents(jobId);
  } catch (error) {
    console.error(error);
  }
}

async function loadJobEvents(jobId: string): Promise<void> {
  try {
    const result = await api.jobEvents(jobId);
    state.events.set(jobId, result.events);
    renderJobs();
  } catch (error) {
    console.error(error);
  }
}

async function refreshFiles(): Promise<void> {
  try {
    const result = await api.listFiles(50);
    state.files = result.items;
  } catch (error) {
    console.error(error);
  }
  renderFiles();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export function mountApp(): void {
  $('analyze-form').addEventListener('submit', (event) => void runAnalyze(event));

  $('select-all').addEventListener('click', () => {
    state.selected = new Set(state.episodes.map((episode) => episode.id));
    state.selectionMode = 'all';
    renderEpisodes();
    renderSelectionCount();
  });

  $('deselect-all').addEventListener('click', () => {
    state.selected = new Set();
    state.selectionMode = 'ids';
    renderEpisodes();
    renderSelectionCount();
  });

  $('invert-selection').addEventListener('click', () => {
    const next = new Set<string>();
    for (const episode of state.episodes) {
      if (!state.selected.has(episode.id)) next.add(episode.id);
    }
    state.selected = next;
    state.selectionMode = 'ids';
    renderEpisodes();
    renderSelectionCount();
  });

  $('apply-range').addEventListener('click', applyRange);
  $('download-selected').addEventListener('click', () => void runCreateJob('ids'));
  $('download-all').addEventListener('click', () => void runCreateJob('all'));
  $('jobs-refresh').addEventListener('click', () => void refreshJobs());
  $('jobs-filter').addEventListener('change', () => void refreshJobs());
  $('files-refresh').addEventListener('click', () => void refreshFiles());

  void (async () => {
    await refreshStatus();
    await Promise.all([refreshJobs(), refreshFiles()]);
  })();

  // Live progress: poll while the tab is visible.
  setInterval(() => {
    if (document.hidden) return;
    if (!$<HTMLInputElement>('jobs-autorefresh').checked) return;
    void refreshJobs();
  }, 2000);

  setInterval(() => {
    if (document.hidden) return;
    void refreshFiles();
  }, 5000);
}

export const __state = state;
