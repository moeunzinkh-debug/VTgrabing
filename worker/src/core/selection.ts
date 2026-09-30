import type { EpisodeRecord, SelectionDescriptor, SelectionMode } from '../shared/types';

/** Minimal shape needed to resolve a selection against a series episode list. */
export interface SelectableEpisode {
  id: string;
  episodeIndex: number;
}

export function normalizeRange(from: number, to: number): { from: number; to: number } {
  const a = Math.trunc(Math.min(from, to));
  const b = Math.trunc(Math.max(from, to));
  return { from: Math.max(1, a), to: Math.max(1, b) };
}

/**
 * Resolve a user selection into the concrete episode ids of a series.
 * The result keeps the natural episode order (ascending `episodeIndex`).
 */
export function resolveSelection(
  episodes: SelectableEpisode[],
  selection: SelectionDescriptor,
): SelectableEpisode[] {
  const ordered = [...episodes].sort((a, b) => a.episodeIndex - b.episodeIndex);
  switch (selection.mode) {
    case 'all':
      return ordered;
    case 'ids': {
      const wanted = new Set(selection.episodeIds ?? []);
      return ordered.filter((episode) => wanted.has(episode.id));
    }
    case 'range': {
      const { from, to } = normalizeRange(selection.range?.from ?? 1, selection.range?.to ?? 1);
      return ordered.filter((episode) => episode.episodeIndex >= from && episode.episodeIndex <= to);
    }
    default:
      return [];
  }
}

/** True when the selection targets every episode of the series. */
export function isFullSelection(episodes: SelectableEpisode[], selection: SelectionDescriptor): boolean {
  return resolveSelection(episodes, selection).length === episodes.length;
}

export function describeSelection(selection: SelectionDescriptor): string {
  switch (selection.mode) {
    case 'all':
      return 'all episodes';
    case 'ids':
      return `${selection.episodeIds?.length ?? 0} selected episode(s)`;
    case 'range': {
      const { from, to } = normalizeRange(selection.range?.from ?? 1, selection.range?.to ?? 1);
      return from === to ? `episode ${from}` : `episodes ${from}-${to}`;
    }
    default:
      return 'unknown selection';
  }
}

/** Toggle a single id inside a Set-like array (used by the frontend). */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/**
 * Given the currently selected ids, an anchor episode index and a target episode
 * index, return the ids that should be selected for a shift-click range.
 */
export function rangeIdsBetween(
  episodes: SelectableEpisode[],
  anchorIndex: number | null,
  targetIndex: number,
): string[] {
  if (anchorIndex === null) return [];
  const { from, to } = normalizeRange(anchorIndex, targetIndex);
  return episodes
    .filter((episode) => episode.episodeIndex >= from && episode.episodeIndex <= to)
    .map((episode) => episode.id);
}

export function selectionFromEpisodes(
  episodes: EpisodeRecord[],
  selectedIds: string[],
  mode: SelectionMode,
): SelectionDescriptor {
  if (mode === 'all') return { mode: 'all' };
  if (mode === 'range') {
    const indexes = episodes
      .filter((episode) => selectedIds.includes(episode.id))
      .map((episode) => episode.episodeIndex);
    if (indexes.length === 0) return { mode: 'ids', episodeIds: [] };
    return { mode: 'range', range: normalizeRange(Math.min(...indexes), Math.max(...indexes)) };
  }
  return { mode: 'ids', episodeIds: selectedIds };
}
