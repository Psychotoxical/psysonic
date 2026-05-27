import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/coverCache', () => ({
  libraryCoverBackfillConfigure: vi.fn(async () => {}),
  libraryCoverBackfillSetUiPriority: vi.fn(async () => {}),
}));

import { libraryCoverBackfillSetUiPriority } from '../api/coverCache';
import {
  __test_resetCoverTraffic,
  coverTrafficBackgroundPaused,
  coverTrafficBeginNavigation,
  coverTrafficEndNavigation,
} from './coverTraffic';

describe('coverTraffic navigation hold', () => {
  beforeEach(() => {
    __test_resetCoverTraffic();
    vi.mocked(libraryCoverBackfillSetUiPriority).mockClear();
  });

  it('route effect cleanup ends navigation hold (does not leak begin)', () => {
    coverTrafficBeginNavigation();
    coverTrafficEndNavigation();
    expect(coverTrafficBackgroundPaused()).toBe(false);

    coverTrafficBeginNavigation();
    coverTrafficEndNavigation();
    expect(coverTrafficBackgroundPaused()).toBe(false);
  });

  it('simulates useCoverNavigationPriority cleanup on pathname change', () => {
    coverTrafficBeginNavigation();
    coverTrafficEndNavigation();
    expect(coverTrafficBackgroundPaused()).toBe(false);

    coverTrafficBeginNavigation();
    coverTrafficEndNavigation();
    coverTrafficEndNavigation();
    expect(coverTrafficBackgroundPaused()).toBe(false);
  });
});
