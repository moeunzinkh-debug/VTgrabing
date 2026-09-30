import { describe, expect, it } from 'vitest';
import {
  describeSelection,
  isFullSelection,
  normalizeRange,
  rangeIdsBetween,
  resolveSelection,
  selectionFromEpisodes,
  toggleId,
} from '../worker/src/core/selection';
import type { EpisodeRecord } from '../worker/src/shared/types';

const episodes = [
  { id: 'ep_1', episodeIndex: 1 },
  { id: 'ep_2', episodeIndex: 2 },
  { id: 'ep_3', episodeIndex: 3 },
  { id: 'ep_4', episodeIndex: 4 },
  { id: 'ep_5', episodeIndex: 5 },
];

describe('resolveSelection', () => {
  it('selects every episode for mode "all"', () => {
    expect(resolveSelection(episodes, { mode: 'all' }).map((e) => e.id)).toEqual([
      'ep_1',
      'ep_2',
      'ep_3',
      'ep_4',
      'ep_5',
    ]);
  });

  it('selects explicit ids and ignores unknown ones', () => {
    expect(resolveSelection(episodes, { mode: 'ids', episodeIds: ['ep_4', 'nope', 'ep_2'] }).map((e) => e.id)).toEqual([
      'ep_2',
      'ep_4',
    ]);
  });

  it('selects an inclusive range and keeps ascending order', () => {
    expect(resolveSelection(episodes, { mode: 'range', range: { from: 2, to: 4 } }).map((e) => e.id)).toEqual([
      'ep_2',
      'ep_3',
      'ep_4',
    ]);
  });

  it('normalizes reversed ranges', () => {
    expect(normalizeRange(5, 2)).toEqual({ from: 2, to: 5 });
    expect(resolveSelection(episodes, { mode: 'range', range: { from: 4, to: 2 } }).map((e) => e.id)).toEqual([
      'ep_2',
      'ep_3',
      'ep_4',
    ]);
  });

  it('clamps impossible ranges', () => {
    expect(resolveSelection(episodes, { mode: 'range', range: { from: 9, to: 42 } })).toEqual([]);
    expect(resolveSelection(episodes, { mode: 'ids', episodeIds: [] })).toEqual([]);
  });
});

describe('selection helpers used by the frontend', () => {
  it('toggles ids', () => {
    expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('computes shift-click ranges', () => {
    expect(rangeIdsBetween(episodes, 2, 4)).toEqual(['ep_2', 'ep_3', 'ep_4']);
    expect(rangeIdsBetween(episodes, 4, 2)).toEqual(['ep_2', 'ep_3', 'ep_4']);
    expect(rangeIdsBetween(episodes, null, 3)).toEqual([]);
  });

  it('describes and compares selections', () => {
    expect(describeSelection({ mode: 'all' })).toBe('all episodes');
    expect(describeSelection({ mode: 'ids', episodeIds: ['a', 'b'] })).toBe('2 selected episode(s)');
    expect(describeSelection({ mode: 'range', range: { from: 3, to: 3 } })).toBe('episode 3');
    expect(describeSelection({ mode: 'range', range: { from: 3, to: 7 } })).toBe('episodes 3-7');
    expect(isFullSelection(episodes, { mode: 'all' })).toBe(true);
    expect(isFullSelection(episodes, { mode: 'ids', episodeIds: ['ep_1'] })).toBe(false);
  });

  it('converts a checkbox selection back into a descriptor', () => {
    const records = episodes.map(
      (episode) => ({ ...episode, title: `Episode ${episode.episodeIndex}` }) as EpisodeRecord,
    );
    expect(selectionFromEpisodes(records, ['ep_2', 'ep_3'], 'range')).toEqual({
      mode: 'range',
      range: { from: 2, to: 3 },
    });
    expect(selectionFromEpisodes(records, ['ep_2', 'ep_3'], 'ids')).toEqual({
      mode: 'ids',
      episodeIds: ['ep_2', 'ep_3'],
    });
    expect(selectionFromEpisodes(records, [], 'range')).toEqual({ mode: 'ids', episodeIds: [] });
  });
});
