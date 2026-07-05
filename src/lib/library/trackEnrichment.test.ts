import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import {
  deriveMoodScores,
  formatQueueBpmTech,
  formatQueueMoodLabels,
  parseTrackEnrichmentFacts,
  resolveQueueBpm,
  resolveDisplayBpm,
  topMoodLabelIds,
} from './trackEnrichment';
import { topDistinctOximediaMoodTagIds, topOximediaMoodTagIds } from '@/config/moodGroups';

const t = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'queue.bpm') return `${opts?.bpm} BPM`;
  if (key === 'queue.moods.calm') return 'Calm';
  if (key === 'queue.moods.peaceful') return 'Peaceful';
  return key;
}) as TFunction;

describe('parseTrackEnrichmentFacts', () => {
  it('does not surface oximedia mood labels in UI while detector is disabled', () => {
    const parsed = parseTrackEnrichmentFacts(
      [
        {
          serverId: 's1',
          trackId: 't1',
          factKind: 'moods',
          sourceKind: 'analysis',
          sourceId: 'oximedia-60s-center',
          valueText: '{"calm":0.6,"peaceful":0.4}',
          confidence: 0.9,
          fetchedAt: 1,
        },
        {
          serverId: 's1',
          trackId: 't1',
          factKind: 'valence',
          sourceKind: 'analysis',
          sourceId: 'oximedia-60s-center',
          valueReal: 0.55,
          confidence: 0.9,
          fetchedAt: 1,
        },
        {
          serverId: 's1',
          trackId: 't1',
          factKind: 'arousal',
          sourceKind: 'analysis',
          sourceId: 'oximedia-60s-center',
          valueReal: 0.42,
          confidence: 0.9,
          fetchedAt: 1,
        },
      ],
      null,
    );
    expect(parsed.moodLabels).toEqual([]);
  });

  it('reads analysis bpm fact with highest confidence', () => {
    const parsed = parseTrackEnrichmentFacts(
      [
        {
          serverId: 's1',
          trackId: 't1',
          factKind: 'bpm',
          sourceKind: 'analysis',
          sourceId: 'oximedia-60s-center',
          valueInt: 128,
          confidence: 0.9,
          fetchedAt: 1,
        },
        {
          serverId: 's1',
          trackId: 't1',
          factKind: 'bpm',
          sourceKind: 'analysis',
          sourceId: 'other',
          valueInt: 110,
          confidence: 0.5,
          fetchedAt: 1,
        },
      ],
      120,
    );
    expect(parsed.measuredBpm).toBe(128);
    expect(parsed.serverBpm).toBe(120);
    expect(resolveQueueBpm(parsed)).toBe(128);
  });
});

describe('resolveQueueBpm', () => {
  it('prefers measured analysis bpm over tag', () => {
    expect(resolveQueueBpm({ serverBpm: 120, measuredBpm: 128, moodLabels: [] })).toBe(128);
  });

  it('falls back to tag bpm when no analysis fact', () => {
    expect(resolveQueueBpm({ serverBpm: 120, measuredBpm: null, moodLabels: [] })).toBe(120);
  });

  it('falls back to measured when tag bpm missing', () => {
    expect(resolveQueueBpm({ serverBpm: null, measuredBpm: 128, moodLabels: [] })).toBe(128);
  });
});

describe('resolveDisplayBpm', () => {
  it('ignores zero tag bpm and uses measured', () => {
    expect(resolveDisplayBpm(0, 132)).toBe(132);
  });
});

describe('formatters', () => {
  it('formats bpm for tech row', () => {
    expect(formatQueueBpmTech({ serverBpm: 120, measuredBpm: 128, moodLabels: [] }, t)).toBe('128 BPM');
  });

  it('localizes mood labels without weights', () => {
    expect(formatQueueMoodLabels(['calm', 'peaceful'], t)).toBe('Calm · Peaceful');
  });
});

describe('topMoodLabelIds', () => {
  it('returns at most two distinct cluster labels from valence/arousal', () => {
    const labels = topMoodLabelIds(0.4, 0.75);
    expect(labels.includes('happy') && labels.includes('excited')).toBe(false);
    expect(labels.length).toBeLessThanOrEqual(2);
  });
});

describe('distinct mood tag picking', () => {
  it('never keeps both happy and excited from raw scores', () => {
    expect(topDistinctOximediaMoodTagIds({ calm: 0.52, happy: 0.9, excited: 0.5 })).toEqual(['happy', 'calm']);
  });

  it('sorts by score descending with id tie-break', () => {
    expect(topOximediaMoodTagIds({ calm: 0.2, happy: 0.9, excited: 0.5 })).toEqual([
      'happy',
      'excited',
      'calm',
    ]);
  });
});

describe('deriveMoodScores', () => {
  it('delegates to soft valence/arousal scoring', () => {
    const scores = deriveMoodScores(0.55, 0.42);
    expect(topDistinctOximediaMoodTagIds(scores, 2).some(id => id === 'calm' || id === 'peaceful')).toBe(true);
  });
});
