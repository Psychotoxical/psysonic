import { describe, expect, it } from 'vitest';
import {
  MOOD_GROUP_IDS,
  MOOD_GROUPS,
  OXIMEDIA_MOOD_TAG_IDS,
  TOP_OXIMEDIA_MOOD_TAG_TEST_SCORES,
  topDistinctOximediaMoodTagIdsFromValenceArousal,
  topOximediaMoodTagIds,
} from './moodGroups';

/** Keep in sync with `psysonic_library::mood_groups` invariant tests. */
describe('moodGroups catalog invariants', () => {
  it('group ids match Rust MOOD_GROUP_IDS', () => {
    expect([...MOOD_GROUP_IDS]).toEqual(['joy', 'sadness', 'dance', 'work', 'romance', 'anger']);
  });

  it('every oximedia tag appears in at least one group', () => {
    for (const tag of OXIMEDIA_MOOD_TAG_IDS) {
      expect(MOOD_GROUPS.some(g => g.tags.includes(tag))).toBe(true);
    }
  });

  it('joy group tags match Rust expand_mood_groups', () => {
    expect(MOOD_GROUPS.find(g => g.id === 'joy')?.tags).toEqual(['happy', 'excited']);
  });

  it('work and romance groups overlap on calm/peaceful', () => {
    const work = MOOD_GROUPS.find(g => g.id === 'work')!.tags;
    const romance = MOOD_GROUPS.find(g => g.id === 'romance')!.tags;
    expect(work.some(t => romance.includes(t))).toBe(true);
  });

  it('anger group tags match Rust expand_mood_groups', () => {
    expect(MOOD_GROUPS.find(g => g.id === 'anger')?.tags).toEqual(['angry', 'tense']);
  });
});

describe('moodScoresFromValenceArousal', () => {
  it('never shows both happy and excited for typical oximedia pop', () => {
    const labels = topDistinctOximediaMoodTagIdsFromValenceArousal(0.4, 0.75);
    expect(labels.includes('happy') && labels.includes('excited')).toBe(false);
    expect(labels.length).toBeLessThanOrEqual(2);
  });

  it('prefers calm or peaceful for low arousal', () => {
    const labels = topDistinctOximediaMoodTagIdsFromValenceArousal(0.55, 0.42);
    expect(labels.some(id => id === 'calm' || id === 'peaceful')).toBe(true);
  });
});

describe('topOximediaMoodTagIds', () => {
  it('matches Rust top_oximedia_mood_tag_ids_from_moods_json test vector', () => {
    expect(topOximediaMoodTagIds(TOP_OXIMEDIA_MOOD_TAG_TEST_SCORES)).toEqual([
      'happy',
      'excited',
      'calm',
    ]);
  });

  it('sorts by score descending with id tie-break', () => {
    expect(topOximediaMoodTagIds({ calm: 0.2, happy: 0.9, excited: 0.5 })).toEqual([
      'happy',
      'excited',
      'calm',
    ]);
  });
});
