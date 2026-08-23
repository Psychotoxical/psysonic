import { describe, expect, it } from 'vitest';
import {
  buildSmartRulesPayload,
  defaultSmartFilters,
} from './playlistsSmart';
import { projectSmartRulesToBasic } from './smartPlaylistBasicProjection';

describe('projectSmartRulesToBasic', () => {
  it('projects a Psysonic Basic document only when rebuilding is exact', () => {
    const filters = {
      ...defaultSmartFilters,
      name: 'Road trip',
      artistContains: 'Massive Attack',
      selectedGenres: ['Trip-Hop', 'Electronic'],
      yearFrom: 1990,
      yearTo: 2010,
      yearEnabled: true,
      minRating: 3,
    };
    const rules = buildSmartRulesPayload(filters);
    const result = projectSmartRulesToBasic(rules, 'psy-smart-Road trip');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters).toMatchObject({
      name: 'Road trip',
      artistContains: 'Massive Attack',
      selectedGenres: ['Trip-Hop', 'Electronic'],
      yearFrom: 1990,
      yearTo: 2010,
      minRating: 3,
    });
  });

  it.each([
    [
      'nested mixed groups',
      {
        all: [
          { any: [{ contains: { title: 'mix' } }, { contains: { album: 'mix' } }] },
          { inTheRange: { year: [2000, 2020] } },
        ],
        limit: 50,
        sort: '+random',
      },
      '/all/0/any',
    ],
    [
      'legacy order',
      {
        all: [{ inTheRange: { year: [2000, 2020] } }],
        limit: 50,
        sort: 'year',
        order: 'desc',
      },
      '/order',
    ],
    [
      'unknown top-level metadata',
      {
        all: [{ inTheRange: { year: [2000, 2020] } }],
        limit: 50,
        sort: '+random',
        futureOption: true,
      },
      '/futureOption',
    ],
    [
      'rules omitted by Basic',
      {
        all: [
          { startsWith: { title: 'A' } },
          { inTheRange: { year: [2000, 2020] } },
        ],
        limit: 50,
        sort: '+random',
      },
      '/all/0/startsWith',
    ],
  ])('refuses destructive conversion of %s', (_name, rules, path) => {
    const result = projectSmartRulesToBasic(rules, 'External');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupportedPaths).toEqual(expect.arrayContaining([path]));
  });

  it('refuses documents that would gain Basic defaults', () => {
    const result = projectSmartRulesToBasic({
      all: [{ contains: { title: 'live' } }],
    }, 'External');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupportedPaths).toEqual(expect.arrayContaining([
      '/all/1',
      '/limit',
      '/sort',
    ]));
  });
});
