import { describe, it, expect } from 'vitest';
import { CONTRIBUTORS } from './settingsCredits';
import { isNewer } from '../utils/componentHelpers/appUpdaterHelpers';

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
