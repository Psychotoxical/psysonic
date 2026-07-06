import { describe, it, expect } from 'vitest';
import { CONTRIBUTORS, themeContributorsFromRegistry } from './settingsCredits';
import { isNewer } from '@/lib/util/appUpdaterHelpers';

describe('CONTRIBUTORS ordering', () => {
  it('is sorted ascending by the `since` app version', () => {
    for (let i = 1; i < CONTRIBUTORS.length; i++) {
      // a preceding entry must never be newer than the one after it
      expect(isNewer(CONTRIBUTORS[i - 1].since, CONTRIBUTORS[i].since)).toBe(false);
    }
  });

  it('puts the original maintainer (v1.0.0) first', () => {
    expect(CONTRIBUTORS[0].github).toBe('Psychotoxical');
  });

  it('breaks `since` ties by first-contribution PR number', () => {
    // nullobject (PR #7) and trbn1 (PR #9) both first appeared in v1.22.0
    const nullobject = CONTRIBUTORS.findIndex(c => c.github === 'nullobject');
    const trbn1 = CONTRIBUTORS.findIndex(c => c.github === 'trbn1');
    expect(nullobject).toBeGreaterThanOrEqual(0);
    expect(nullobject).toBeLessThan(trbn1);
  });
});

describe('themeContributorsFromRegistry', () => {
  it('groups themes by author and sorts both authors and theme names', () => {
    const result = themeContributorsFromRegistry([
      { author: 'bob', name: 'Zephyr' },
      { author: 'alice', name: 'Bravo' },
      { author: 'bob', name: 'Aurora' },
      { author: 'alice', name: 'Alpha' },
    ]);
    expect(result).toEqual([
      { github: 'alice', themes: ['Alpha', 'Bravo'] },
      { github: 'bob', themes: ['Aurora', 'Zephyr'] },
    ]);
  });

  it('dedupes an author across casing drift, keeping the first-seen casing', () => {
    const result = themeContributorsFromRegistry([
      { author: 'Bob', name: 'One' },
      { author: 'bob', name: 'Two' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].github).toBe('Bob');
    expect(result[0].themes).toEqual(['One', 'Two']);
  });

  it('skips entries with a blank or whitespace-only author', () => {
    const result = themeContributorsFromRegistry([
      { author: '  ', name: 'Blank' },
      { author: 'alice', name: 'Alpha' },
    ]);
    expect(result).toEqual([{ github: 'alice', themes: ['Alpha'] }]);
  });

  it('does not list a repeated theme name twice for one author', () => {
    const result = themeContributorsFromRegistry([
      { author: 'alice', name: 'Alpha' },
      { author: 'alice', name: 'Alpha' },
    ]);
    expect(result).toEqual([{ github: 'alice', themes: ['Alpha'] }]);
  });

  it('excludes the project org account (any casing) from theme credits', () => {
    const result = themeContributorsFromRegistry([
      { author: 'Psysonic', name: 'Official One' },
      { author: 'psysonic', name: 'Official Two' },
      { author: 'alice', name: 'Alpha' },
    ]);
    expect(result).toEqual([{ github: 'alice', themes: ['Alpha'] }]);
  });
});
