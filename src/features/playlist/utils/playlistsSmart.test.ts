import { describe, expect, it } from 'vitest';
import { buildSmartRulesPayload, defaultSmartFilters, parseSmartRulesToFilters } from '@/features/playlist/utils/playlistsSmart';

describe('buildSmartRulesPayload', () => {
  it('collapses exclude-all-genres into an untagged-only rule', () => {
    const filters = {
      ...defaultSmartFilters,
      genreMode: 'exclude' as const,
      selectedGenres: ['Rock', 'Jazz', 'Pop'],
    };
    const rules = buildSmartRulesPayload(filters, { allGenres: ['Rock', 'Jazz', 'Pop'] });
    const all = rules.all as Record<string, unknown>[];
    expect(all.some(r => (r as { is?: { genre?: string } }).is?.genre === '')).toBe(true);
    expect(all.filter(r => 'notContains' in r)).toHaveLength(0);
  });

  it('keeps per-genre exclusions when only some genres are selected', () => {
    const filters = {
      ...defaultSmartFilters,
      genreMode: 'exclude' as const,
      selectedGenres: ['Rock'],
    };
    const rules = buildSmartRulesPayload(filters, { allGenres: ['Rock', 'Jazz'] });
    const all = rules.all as Record<string, unknown>[];
    expect(all).toContainEqual({ notContains: { genre: 'Rock' } });
  });
});

describe('parseSmartRulesToFilters', () => {
  it('restores untagged-only exclude rules', () => {
    const parsed = parseSmartRulesToFilters(
      { all: [{ is: { genre: '' } }], limit: 50, sort: '+random' },
      'psy-smart-test',
    );
    expect(parsed.untaggedGenresOnly).toBe(true);
    expect(parsed.genreMode).toBe('exclude');
  });
});
