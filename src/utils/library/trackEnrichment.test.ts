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
import { topOximediaMoodTagIds } from '../../config/moodGroups';

const t = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'queue.bpm') return `${opts?.bpm} BPM`;
  if (key === 'queue.moods.calm') return 'Calm';
  if (key === 'queue.moods.peaceful') return 'Peaceful';
  return key;
}) as TFunction;

describe('parseTrackEnrichmentFacts', () => {
  it('reads raw moods json from oximedia fact', () => {
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
      ],
      null,
    );
    expect(parsed.moodLabels).toEqual(['calm', 'peaceful']);
  });

  it('derives mood labels from valence/arousal with soft scoring', () => {
    const parsed = parseTrackEnrichmentFacts(
      [
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
    expect(parsed.moodLabels.some(id => id === 'calm' || id === 'peaceful')).toBe(true);
  });

  it('prefers valence/arousal over quadrant moods json in facts', () => {
    const parsed = parseTrackEnrichmentFacts(
      [
        {
          serverId: 's1',
          trackId: 't1',
          factKind: 'moods',
          sourceKind: 'analysis',
          sourceId: 'oximedia-60s-center',
          valueText: '{"happy":0.9,"excited":0.8}',
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
    expect(parsed.moodLabels).not.toEqual(['happy', 'excited']);
  });
});

describe('resolveQueueBpm', () => {
  it('prefers server bpm over measured', () => {
    expect(resolveQueueBpm({ serverBpm: 120, measuredBpm: 128, moodLabels: [] })).toBe(120);
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
    expect(formatQueueBpmTech({ serverBpm: 120, measuredBpm: 128, moodLabels: [] }, t)).toBe('120 BPM');
  });

  it('localizes mood labels without weights', () => {
    expect(formatQueueMoodLabels(['calm', 'peaceful'], t)).toBe('Calm · Peaceful');
  });
});

describe('topMoodLabelIds', () => {
  it('sorts by score descending', () => {
    expect(topMoodLabelIds({ calm: 0.2, happy: 0.9, excited: 0.5 })).toEqual(['happy', 'excited', 'calm']);
  });
});

describe('deriveMoodScores', () => {
  it('delegates to soft valence/arousal scoring', () => {
    const scores = deriveMoodScores(0.55, 0.42);
    expect(topOximediaMoodTagIds(scores, 2).some(id => id === 'calm' || id === 'peaceful')).toBe(true);
  });
});
