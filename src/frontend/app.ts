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
    const kindLabel =
      provider.key === 'tiktok-ssstik'
        ? 'unofficial third party'
        : provider.kind === 'mock'
          ? 'mock · synthetic only'
          : provider.kind === 'http'
            ? 'real'
            : provider.kind;
    const providerChip = chip(
      `${kindLabel}: ${provider.key}${provider.available ? '' : ' (off)'}`,
      provider.available
        ? provider.kind === 'mock' || provider.key === 'tiktok-ssstik'
          ? 'warn'
          : 'ok'
        : anyAvailable
          ? 'muted'
          : 'error',
    );
    providerChip.title = provider.reason ?? '';
    badges.appendChild(providerChip);
  }
  if (state.status?.grab && !state.status.grab.enabled) {
    badges.appendChild(chip('grabber off', 'error'));
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
  const grab = state.status?.grab;
  if (available.length === 0) {
    hint.textContent =
      'No extractor is configured. Turn the real grabber on with GRAB_ENABLED=true (it needs no secrets), or point SOURCE_API_BASE_URL at your own catalog API.';
    hint.classList.add('warn-text');
    return;
  }
  hint.classList.remove('warn-text');
  const parts = available.map((item) => `${item.key}: ${item.reason ?? item.label}`);
  if (grab?.enabled) {
    parts.push(
      `per analyze: up to ${grab.maxVideos} videos, ${(grab.maxVideoBytes / 1024 / 1024 / 1024).toFixed(1)} GiB each` +
        (grab.allowedHosts.length > 0 ? `, hosts ${grab.allowedHosts.join(', ')}` : ', any public host') +
        (grab.crawl ? `, crawls up to ${grab.maxCrawlPages} linked episode page(s)` : ''),
    );
  }
  hint.textContent = parts.join(' • ');
}

/** True when every rendition of a found video is encrypted (DRM / #EXT-X-KEY). */
/**
 * Why the grabber can list this video but cannot store it: `encrypted` (DRM /
 * `#EXT-X-KEY`) or `live` (a playlist that is still running). Mirrors the server-side
 * filter in `JobService`, so the list you see is the list that gets queued.
 */
function tiktokSsstikAvailable(): boolean {
  return state.status?.downloadProviders.some((provider) => provider.key === 'tiktok-ssstik' && provider.available) ?? false;
}

function tiktokSsstikSelected(): boolean {
  return $<HTMLSelectElement>('opt-provider').value === 'tiktok-ssstik' && tiktokSsstikAvailable();
}

function episodeBlockReason(episode: EpisodeRecord): 'encrypted' | 'live' | 'listing' | null {
  const streams = episode.streams;
  if (streams.length === 0 && episode.metadata.listOnly === true) {
    if (episode.metadata.platform === 'tiktok' && tiktokSsstikSelected()) return null;
    return 'listing';
  }
  if (streams.length === 0) {
    if (episode.metadata.encrypted === true) return 'encrypted';
    if (episode.metadata.live === true) return 'live';
    return null;
  }
  if (streams.every((stream) => stream.encrypted === true)) return 'encrypted';
  if (streams.every((stream) => stream.live === true)) return 'live';
  if (streams.every((stream) => stream.encrypted === true || stream.live === true)) return 'encrypted';
  return null;
}

function isEncryptedOnly(episode: EpisodeRecord): boolean {
  return episodeBlockReason(episode) !== null;
}

/** `EP 12` when the creator numbered it, `VIDEO` for a normal video, else `S01E03`. */
function episodeTag(episode: EpisodeRecord, series: SeriesRecord | null): string {
  const number = episode.metadata.episodeNumber;
  if (typeof number === 'number' && Number.isFinite(number)) return `EP ${number}`;
  if (series?.metadata?.contentKind === 'normal-video' || series?.metadata?.contentKind === 'unknown') return 'VIDEO';
  return episodeLabel(episode.episodeIndex);
}

/** The TikTok analyzer's verdict (mini-drama or normal video) and the signals behind it. */
function renderVerdict(header: HTMLElement): void {
  const meta = state.series?.metadata ?? {};
  const kind = meta.contentKind;
  if (kind !== 'mini-drama' && kind !== 'normal-video' && kind !== 'unknown') return;
  const box = el('div', 'verdict');
  box.dataset.kind = String(kind);
  const row = el('div', 'verdict-row');
  row.appendChild(
    kind === 'unknown'
      ? chip('Unclassified · មិនទាន់ដឹងប្រភេទ', 'warn')
      : chip(kind === 'mini-drama' ? 'Mini-drama · ភាពយន្តខ្លី' : 'Normal video · វីដេអូធម្មតា', kind === 'mini-drama' ? 'ok' : 'muted'),
  );
  if (typeof meta.confidence === 'string') row.appendChild(chip(`${meta.confidence} confidence`, meta.confidence === 'low' ? 'warn' : 'muted'));
  if (kind === 'mini-drama') {
    const current = meta.currentEpisodeNumber;
    const total = meta.totalEpisodes;
    if (typeof current === 'number') {
      row.appendChild(chip(`this link: EP ${current}${typeof total === 'number' ? ` / ${total}` : ''}`, 'muted'));
    } else if (typeof total === 'number') {
      row.appendChild(chip(`${total} episodes`, 'muted'));
    }
  }
  box.appendChild(row);
  const signals = Array.isArray(meta.signals) ? (meta.signals as unknown[]).map(String) : [];
  if (signals.length > 0) box.appendChild(el('p', 'muted small', `Why: ${signals.join(' · ')}`));
  if (typeof meta.listNote === 'string' && meta.listNote) box.appendChild(el('p', 'warn-text small', meta.listNote));
  if (kind === 'unknown') {
    box.appendChild(
      el(
        'p',
        'warn-text small',
        'TikTok មិនឱ្យ server អានព័ត៌មានវីដេអូនេះទេ ដូច្នេះបង្ហាញតែ link ប៉ុណ្ណោះ (មិនស្គាល់ចំណងជើង ឬលេខភាគ)។',
      ),
    );
  }
  header.appendChild(box);
}

/** Largest advertised size across the renditions of one video. */
function episodeSize(episode: EpisodeRecord): number {
  return episode.streams.reduce((total, stream) => Math.max(total, stream.sizeBytes ?? 0), 0);
}

/** Pick a direct media file for browser preview; browsers cannot play an HLS/DASH manifest directly. */
function directPreviewSource(episode: EpisodeRecord): string | null {
  const stream = episode.streams.find((candidate) => {
    if (!candidate.url || candidate.encrypted || candidate.live || candidate.kind === 'hls' || candidate.kind === 'dash') {
      return false;
    }
    try {
      return !/\.(?:m3u8?|mpd)$/i.test(new URL(candidate.url).pathname);
    } catch {
      return !/\.(?:m3u8?|mpd)(?:[?#]|$)/i.test(candidate.url);
    }
  });
  return stream?.url ?? null;
}

function filePlayerKind(file: FileRecord): 'video' | 'audio' | null {
  // The mock provider deliberately stores synthetic bytes, not a playable video.
  if (file.provider === 'mock') return null;
  const type = (file.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return null;
}

function createMediaPlayer(
  kind: 'video' | 'audio',
  src: string,
  label: string,
  poster?: string | null,
): HTMLMediaElement {
  const player = document.createElement(kind) as HTMLMediaElement;
  player.className = 'media-player';
  player.controls = true;
  player.preload = 'none';
  player.setAttribute('playsinline', '');
  player.setAttribute('aria-label', label);
  player.src = src;
  if (kind === 'video' && poster) (player as HTMLVideoElement).poster = poster;
  return player;
}

function showAnalysisResult(message: string, warning = false): void {
  const result = $('analyze-result');
  result.textContent = message
    ? `${message}\n\nវិភាគគ្រាន់តែរកប្រភពវីដេអូប៉ុណ្ណោះ — មិនមែនមានន័យថាទាញយករួចទេ។`
    : '';
  result.hidden = !message;
  result.classList.toggle('analysis-result-warn', warning);
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
  if (typeof state.series.metadata?.resolvedUrl === 'string' && state.series.metadata.resolvedUrl !== state.series.sourceUrl) {
    header.appendChild(el('p', 'muted small', `resolved: ${state.series.metadata.resolvedUrl}`));
  }
  renderVerdict(header);

  // What the grabber actually did on that URL (pages opened, hosts refused, ...).
  const diagnostics = Array.isArray(state.series.metadata?.diagnostics)
    ? (state.series.metadata.diagnostics as unknown[]).map((line) => String(line))
    : [];
  const diagBox = $('analyze-diag');
  const diagText = $('analyze-diag-text');
  diagBox.hidden = diagnostics.length === 0;
  diagText.textContent = diagnostics.join('\n');

  const blocked = state.episodes.filter(isEncryptedOnly).length;
  const listingCount = state.episodes.filter((episode) => episodeBlockReason(episode) === 'listing').length;
  const tiktokListingCount = state.episodes.filter(
    (episode) => episodeBlockReason(episode) === 'listing' && episode.metadata.platform === 'tiktok',
  ).length;
  const protectedCount = state.episodes.filter((episode) => episodeBlockReason(episode) === 'encrypted').length;
  const liveCount = state.episodes.filter((episode) => episodeBlockReason(episode) === 'live').length;
  const queueNote = $('queue-note');
  queueNote.textContent =
    blocked > 0
      ? [
          protectedCount > 0 ? `${protectedCount} encrypted (DRM / #EXT-X-KEY): VTGrab never fetches keys or decrypts` : '',
          liveCount > 0 ? `${liveCount} live broadcast(s): no finished file to store yet` : '',
          listingCount > 0
            ? `${listingCount} listed for reference only: no direct stream${tiktokListingCount > 0 && tiktokSsstikAvailable() ? '; select the explicit SSSTik third-party provider for eligible TikTok posts' : ''}`
            : '',
          'these are listed but never queued',
        ]
        .filter(Boolean)
        .join(' - ')
      : 'One job item per video; the Worker streams each source into R2 and the queue retries failures.';
  queueNote.classList.toggle('warn-text', blocked > 0);

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
  // "source" = whatever the host offers, which is what a grabbed page usually has.
  if (!ordered.includes('source')) ordered.push('source');
  clear(select);
  for (const quality of ordered.length > 1 ? ordered : ['source']) {
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
    const blocked = isEncryptedOnly(episode);
    const item = el('label', blocked ? (episodeBlockReason(episode) === 'listing' ? 'episode episode-listed' : 'episode episode-blocked') : 'episode');
    const checkbox = el('input') as HTMLInputElement;
    checkbox.type = 'checkbox';
    // A video we are not able to decrypt is shown but cannot be selected.
    checkbox.checked = !blocked && state.selected.has(episode.id);
    checkbox.disabled = blocked;
    checkbox.dataset.episodeId = episode.id;
    checkbox.dataset.episodeIndex = String(episode.episodeIndex);
    checkbox.addEventListener('click', onEpisodeClick);

    const body = el('div', 'episode-body');
    body.appendChild(el('span', 'episode-index', episodeTag(episode, state.series)));
    body.appendChild(el('span', 'episode-title', episode.title));
    const meta = el('div', 'episode-meta');
    meta.appendChild(el('span', undefined, formatDuration(episode.durationSeconds)));
    const size = episodeSize(episode);
    if (size > 0) meta.appendChild(el('span', 'chip chip-muted', formatBytes(size)));
    for (const stream of episode.streams.slice(0, 4)) {
      const quality = el('span', 'chip chip-muted', `${stream.quality}${stream.container ? ` · ${stream.container}` : ''}`);
      quality.title = stream.note ?? stream.url ?? '';
      meta.appendChild(quality);
    }
    if (episode.streams.length > 4) meta.appendChild(el('span', 'chip chip-muted', `+${episode.streams.length - 4} more`));
    const kind = episode.streams[0]?.kind;
    if (kind && kind !== 'progressive') meta.appendChild(el('span', 'chip chip-muted', kind.toUpperCase()));
    if (episode.metadata.current === true) meta.appendChild(el('span', 'chip chip-ok', 'your link'));
    if (blocked) {
      const reason = episodeBlockReason(episode);
      if (reason === 'listing') {
        meta.appendChild(el('span', 'chip chip-muted', 'listed only'));
      } else {
        meta.appendChild(
          el('span', 'chip chip-error', reason === 'live' ? 'live - not a file' : 'encrypted - not grabbable'),
        );
      }
    }
    body.appendChild(meta);

    const source = episode.streams.find((stream) => stream.url)?.url ?? episode.sourceUrl;
    const links = el('div', 'episode-links');
    if (source) {
      const open = el('a', 'link', 'source') as HTMLAnchorElement;
      open.href = source;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      links.appendChild(open);
    }

    const previewSource = !blocked ? directPreviewSource(episode) : null;
    if (previewSource) {
      const preview = el('a', 'link', 'preview in new tab') as HTMLAnchorElement;
      preview.href = api.sourcePreviewUrl(previewSource);
      preview.target = '_blank';
      preview.rel = 'noopener';
      preview.title = 'Play through the guarded Worker proxy (no source-site cookies are sent)';
      links.appendChild(preview);

      const showPreview = el('button', 'link-button preview-toggle', 'Watch here');
      showPreview.type = 'button';
      let previewPanel: HTMLDivElement | null = null;
      showPreview.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (previewPanel) {
          previewPanel.remove();
          previewPanel = null;
          showPreview.textContent = 'Watch here';
          return;
        }
        previewPanel = el('div', 'media-preview episode-preview');
        const player = createMediaPlayer(
          'video',
          api.sourcePreviewUrl(previewSource),
          `Preview ${episode.title}`,
          episode.thumbnailUrl,
        ) as HTMLVideoElement;
        const note = el('p', 'muted small preview-error', 'Preview could not be played. The source may block preview; queue it and try the stored file after download.');
        note.hidden = true;
        player.addEventListener('error', () => {
          note.hidden = false;
        });
        previewPanel.append(player, note);
        body.appendChild(previewPanel);
        showPreview.textContent = 'Hide preview';
      });
      links.appendChild(showPreview);
    } else if (!blocked && episode.streams.some((stream) => stream.kind === 'hls' || stream.kind === 'dash')) {
      links.appendChild(el('span', 'muted small', 'Adaptive stream — preview after download'));
    }
    if (links.childNodes.length > 0) body.appendChild(links);

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
    for (const id of ids) {
      const episode = state.episodes.find((item) => item.id === id);
      if (episode && !isEncryptedOnly(episode)) state.selected.add(id);
    }
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
  if (job.options?.provider) {
    badges.appendChild(
      el(
        'span',
        job.options.provider === 'mock' ? 'badge status-partial' : 'badge muted',
        job.options.provider === 'mock' ? 'mock · synthetic, not a video' : `provider: ${job.options.provider}`,
      ),
    );
  }
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
    list.appendChild(
      el(
        'p',
        'muted',
        'No downloads have finished yet. “Found” or “queued” is not the same as a saved video. Wait for the job to complete; files appear here automatically. / មិនទាន់មានវីដេអូដែលទាញយកចប់ទេ។',
      ),
    );
    return;
  }
  const table = el('table', 'files-table');
  const head = el('tr');
  for (const label of ['File', 'Size', 'Quality', 'Provider', 'Stored', 'Actions']) {
    head.appendChild(el('th', undefined, label));
  }
  table.appendChild(head);

  for (const file of state.files) {
    const row = el('tr');
    row.appendChild(el('td', 'filename', file.filename));
    row.appendChild(el('td', undefined, formatBytes(file.size)));
    row.appendChild(el('td', undefined, file.quality ?? '—'));
    const providerCell = el('td');
    if (file.provider === 'mock') {
      providerCell.appendChild(chip('mock · synthetic only', 'warn'));
      providerCell.appendChild(el('div', 'muted small', 'not a real video / មិនមែនវីដេអូពិត'));
    } else {
      providerCell.textContent = file.provider;
    }
    row.appendChild(providerCell);
    row.appendChild(el('td', 'muted small', formatTime(file.createdAt)));

    const actions = el('td', 'file-actions');
    const link = el('a', 'link', 'download') as HTMLAnchorElement;
    link.href = api.fileDownloadUrl(file.id);
    actions.appendChild(link);

    const playerKind = filePlayerKind(file);
    let previewRow: HTMLTableRowElement | null = null;
    if (playerKind) {
      previewRow = el('tr', 'file-preview-row');
      previewRow.hidden = true;
      const previewCell = el('td');
      previewCell.colSpan = 6;
      const panel = el('div', 'media-preview file-preview');
      const player = createMediaPlayer(playerKind, api.filePreviewUrl(file.id), `Play ${file.filename}`);
      const note = el('p', 'muted small preview-error', 'This browser could not play this format. You can still download the file.');
      note.hidden = true;
      player.addEventListener('error', () => {
        note.hidden = false;
      });
      panel.append(player, note);
      previewCell.appendChild(panel);
      previewRow.appendChild(previewCell);

      const play = el('button', 'link-button file-play', 'Play here');
      play.type = 'button';
      play.setAttribute('aria-expanded', 'false');
      play.addEventListener('click', () => {
        previewRow!.hidden = !previewRow!.hidden;
        const isOpen = !previewRow!.hidden;
        play.textContent = isOpen ? 'Hide player' : 'Play here';
        play.setAttribute('aria-expanded', String(isOpen));
      });
      actions.appendChild(play);
    }

    const remove = el('button', 'link-button danger', 'delete');
    remove.addEventListener('click', () => void runDeleteFile(file.id));
    actions.appendChild(remove);
    row.appendChild(actions);
    table.appendChild(row);
    if (previewRow) table.appendChild(previewRow);
  }
  list.appendChild(table);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * The first http(s) link inside whatever was pasted. TikTok's "Share" text is
 * `Check out @user's video! https://vt.tiktok.com/ZS…/ #fyp`, not a bare URL, and the
 * API rightly rejects that as "not a URL".
 */
export function extractUrl(pasted: string): string {
  const text = pasted.trim();
  if (!text || /^https?:\/\/\S+$/i.test(text)) return text;
  const found = /https?:\/\/[^\s<>"'`\u201c\u201d\u2018\u2019]+/i.exec(text);
  // Sentence punctuation right after a link is not part of it.
  return found ? found[0].replace(/[)\],.;:!?]+$/, '') : text;
}

async function runAnalyze(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const input = $<HTMLInputElement>('analyze-url');
  let url = extractUrl(input.value);
  if (url && !/^https?:\/\//i.test(url) && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(url)) {
    url = `https://${url}`;
  }
  // Show what is actually being analyzed when it differs from what was pasted.
  if (url && url !== input.value.trim()) input.value = url;
  const sourceKey = $<HTMLSelectElement>('analyze-source').value || undefined;
  const refresh = $<HTMLInputElement>('analyze-refresh').checked;
  const queueAll = $<HTMLInputElement>('analyze-queue').checked;

  const errorBox = $('analyze-error');
  errorBox.hidden = true;
  showAnalysisResult('');
  if (!url) return;

  state.analyzing = true;
  $<HTMLButtonElement>('analyze-submit').disabled = true;

  try {
    const result = await api.analyze(url, sourceKey, refresh, queueAll);
    state.series = result.series;
    state.episodes = result.episodes;
    // Preselect every item that can become a file; analyzing itself only finds sources.
    state.selected = new Set(
      result.episodes.filter((episode) => !isEncryptedOnly(episode)).map((episode) => episode.id),
    );
    state.anchorIndex = null;
    state.selectionMode = 'all';
    renderSeries();
    renderSelectionCount();

    const foundCount = result.episodes.length;
    const downloadableCount = result.episodes.filter((episode) => !isEncryptedOnly(episode)).length;
    const sourceNote = `via ${result.extractor}${result.cached ? ' (cached result)' : ''}`;
    // The analyzer could only list the bare link (the host refused it): say so first,
    // in the warning style, so "Found 1 video" is never mistaken for a full analysis.
    const degradedNote =
      result.series.metadata?.degraded === true && typeof result.series.metadata.listNote === 'string'
        ? result.series.metadata.listNote
        : '';
    const setAnalysisResult = (message: string, warning = false): void =>
      showAnalysisResult(degradedNote ? `⚠ ${degradedNote}\n\n${message}` : message, warning || degradedNote !== '');
    if (result.job) {
      state.details.set(result.job.job.id, result.job);
      state.expanded.add(result.job.job.id);
      const message =
        `Found ${foundCount} video source(s) ${sourceNote}. Queued ${result.job.job.totalItems} for download ` +
        `(job ${result.job.job.id}); this is not a saved video yet. Watch the job below. ` +
        'Playable files appear in Downloaded files after the items complete.';
      setAnalysisResult(message);
      toast(`Found ${foundCount}; queued ${result.job.job.totalItems}. Download is not complete yet.`, 'info');
      await Promise.all([refreshJobs(), refreshFiles()]);
    } else if (foundCount === 0) {
      const message = `No video sources found ${sourceNote}. Check the link and the grabber diagnostics.`;
      setAnalysisResult(message, true);
      toast(message, 'info');
    } else if (
      queueAll &&
      downloadableCount === 0 &&
      result.episodes.length > 0 &&
      result.episodes.every((episode) => episode.metadata.platform === 'tiktok' && episode.metadata.listOnly === true)
    ) {
      const message = tiktokSsstikAvailable()
        ? `Found ${foundCount} TikTok post(s) ${sourceNote}. The official analyzer provides metadata only. ` +
          'To try the optional unofficial path, choose “TikTok via SSSTik” under Provider, confirm rights and third-party URL sharing, then click Download all. One TikTok post becomes one job item; live service behavior is not guaranteed.'
        : `Found ${foundCount} TikTok post(s) ${sourceNote}. The official analyzer provides metadata only. ` +
          'An optional unofficial SSSTik adapter is present but off by default. Set TIKTOK_SSTIK_ENABLED=true on this deployment, reload, then choose that provider and confirm rights/third-party URL sharing. Live service behavior is not guaranteed.';
      setAnalysisResult(message, true);
      toast('TikTok posts are listed; see the instructions to enable or use the optional provider.', 'info');
    } else if (queueAll && downloadableCount === 0) {
      const message =
        `Found ${foundCount} source(s) ${sourceNote}, but none can be downloaded (for example, DRM-protected, live, or listing-only). ` +
        'See the labels on the video cards for details.';
      setAnalysisResult(message, true);
      toast('Sources found, but none is a downloadable file.', 'info');
    } else if (!queueAll) {
      const message =
        `Found ${foundCount} video source(s) ${sourceNote}. No download was queued. ` +
        'Review the list, then choose Download selected or Download all.';
      setAnalysisResult(message);
      toast(`Found ${foundCount} video source(s); no download was started.`, 'info');
    } else {
      const message =
        `Found ${foundCount} video source(s) ${sourceNote}, but no download job was created. ` +
        'Select the available videos and start a download below.';
      setAnalysisResult(message, true);
      toast('Sources found, but no download job was created.', 'info');
    }
  } catch (error) {
    showAnalysisResult('');
    showError(errorBox, error);
  } finally {
    state.analyzing = false;
    $<HTMLButtonElement>('analyze-submit').disabled = false;
  }
}

/**
 * Plain-language Khmer explanation per failure `reason` the TikTok analyzer reports
 * (`details.reason`), shown under the English message.
 */
const FAILURE_HINTS_KM: Record<string, string> = {
  'playlist-link':
    'នេះជា link playlist / collection។ TikTok មិនផ្ញើបញ្ជីភាគទៅ server បានទេ។ សូមបើកភាគណាមួយក្នុង TikTok រួច copy link នៃភាគនោះមក paste វិញ។',
  'short-link-not-found':
    'TikTok ថា short link នេះមិនមានទេ។ ប្រហែលជាវាខុស ឬផុតកំណត់ ឬត្រូវបានលុប។ សូម copy link ម្តងទៀតពី TikTok។',
  unavailable:
    'TikTok ថាវីដេអូនេះមើលមិនបាន (private, ត្រូវបានលុប ឬត្រូវបានទប់ស្កាត់ដោយតំបន់ / IP)។ VTGrab មិន login ឬរំលង bot check ទេ។',
  'no-public-data':
    'TikTok មិនឱ្យ server អានទំព័រនេះទេ (bot check)។ សូមបើក link ក្នុង browser រួច copy link វែង (www.tiktok.com/@…/video/…) មក paste។',
  'no-video-id':
    'TikTok មិនបានប្រាប់ថា link នេះជាវីដេអូមួយណាទេ។ សូមបើក link ក្នុង browser រួច copy link វែងមក paste។',
  'profile-link': 'នេះជា link គណនី (profile) មិនមែនវីដេអូទេ។ សូម paste link នៃភាគណាមួយ។',
};

interface FailureDetails {
  reason?: string;
  resolvedUrl?: string;
  diagnostics: string[];
}

/** What the API attached to a failed request (`error.details`), tolerant of any shape. */
function readFailureDetails(error: unknown): FailureDetails {
  const raw = error instanceof ApiError ? error.details : undefined;
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    resolvedUrl: typeof record.resolvedUrl === 'string' ? record.resolvedUrl : undefined,
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics.map((line) => String(line)) : [],
  };
}

function showError(node: HTMLElement, error: unknown): void {
  const message = error instanceof ApiError ? error.message : (error as Error).message;
  const details = readFailureDetails(error);
  clear(node);
  node.appendChild(el('p', 'error-message', message));
  const hint = details.reason ? FAILURE_HINTS_KM[details.reason] : undefined;
  if (hint) {
    const note = el('p', 'error-hint', hint);
    note.lang = 'km';
    node.appendChild(note);
  }
  // What the analyzer actually did, step by step: the one thing that tells a blocked
  // request from a bad link, and what to paste into a bug report.
  if (details.diagnostics.length > 0) {
    const box = el('details', 'diag error-diag');
    box.appendChild(el('summary', undefined, 'technical details · ព័ត៌មានបច្ចេកទេស'));
    const lines = [...details.diagnostics];
    if (details.resolvedUrl) lines.unshift(`final url: ${details.resolvedUrl}`);
    box.appendChild(el('pre', undefined, lines.join('\n')));
    node.appendChild(box);
  }
  node.hidden = false;
  toast(message, 'error');
}

async function runCreateJob(mode: 'ids' | 'all'): Promise<void> {
  if (!state.series) return;
  const provider = $<HTMLSelectElement>('opt-provider').value;
  if (provider === 'tiktok-ssstik' && !$<HTMLInputElement>('third-party-consent').checked) {
    $('job-create-status').textContent = 'Confirm rights and third-party URL sharing above first.';
    toast('Confirm that you have permission and agree to send the TikTok URL to SSSTik.', 'error');
    return;
  }
  const seriesId = state.series.id;
  const ids =
    mode === 'all'
      ? // "all" never means "including the ones we refuse to decrypt".
        state.episodes.filter((episode) => !isEncryptedOnly(episode)).map((episode) => episode.id)
      : [...state.selected];
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
    ...(provider ? { provider } : {}),
    ...(provider === 'tiktok-ssstik' ? { thirdPartyConsent: true } : {}),
  };

  try {
    const detail = await api.createJob(
      seriesId,
      mode === 'all' ? { mode: 'all' } : { mode: 'ids', episodeIds: ids },
      options,
    );
    state.details.set(detail.job.id, detail);
    state.expanded.add(detail.job.id);
    status.textContent = `job ${detail.job.id} queued (${detail.items.length} items) — waiting for download`;
    showAnalysisResult(
      `Download queued as job ${detail.job.id} (${detail.items.length} item(s)); this is not a saved video yet. Watch Jobs below. Files appear here after the items complete.`,
    );
    toast(`Queued ${detail.items.length} item(s); download is not complete yet.`, 'info');
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

function onDownloadProviderChange(): void {
  const useSsstik = tiktokSsstikSelected();
  $('third-party-warning').hidden = !useSsstik;
  $('third-party-consent-row').hidden = !useSsstik;
  $<HTMLInputElement>('third-party-consent').checked = false;

  const previouslySelected = new Set(state.selected);
  if (useSsstik && state.selectionMode === 'all') {
    state.selected = new Set(state.episodes.filter((episode) => !isEncryptedOnly(episode)).map((episode) => episode.id));
  } else {
    state.selected = new Set(
      [...previouslySelected].filter((id) => {
        const episode = state.episodes.find((item) => item.id === id);
        return episode !== undefined && !isEncryptedOnly(episode);
      }),
    );
  }
  state.anchorIndex = null;
  renderSeries();
}

function applyRange(): void {
  const from = Number.parseInt($<HTMLInputElement>('range-from').value, 10) || 1;
  const to = Number.parseInt($<HTMLInputElement>('range-to').value, 10) || from;
  const range = normalizeRange(from, to);
  state.selected = new Set(
    state.episodes
      .filter(
        (episode) =>
          !isEncryptedOnly(episode) && episode.episodeIndex >= range.from && episode.episodeIndex <= range.to,
      )
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
  $('opt-provider').addEventListener('change', onDownloadProviderChange);

  $('select-all').addEventListener('click', () => {
    state.selected = new Set(state.episodes.filter((episode) => !isEncryptedOnly(episode)).map((episode) => episode.id));
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
      if (!isEncryptedOnly(episode) && !state.selected.has(episode.id)) next.add(episode.id);
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
