import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/coverCache', () => ({
  libraryCoverBackfillConfigure: vi.fn(async () => {}),
  libraryCoverBackfillSetUiPriority: vi.fn(async () => {}),
}));

import { libraryCoverBackfillSetUiPriority } from '@/lib/api/coverCache';
import {
  __test_resetCoverTraffic,
  coverTrafficBackgroundPaused,
  coverTrafficBeginGridPagination,
  coverTrafficBeginNavigation,
  coverTrafficEndGridPagination,
  coverTrafficEndNavigation,
  coverTrafficGridPaginationDepth,
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

describe('coverTraffic grid pagination hold', () => {
  beforeEach(() => {
    __test_resetCoverTraffic();
  });

  it('pauses middle/low cover work while album pages fetch', () => {
    coverTrafficBeginGridPagination();
    expect(coverTrafficBackgroundPaused()).toBe(true);
    expect(coverTrafficGridPaginationDepth()).toBe(1);
    coverTrafficEndGridPagination();
    expect(coverTrafficBackgroundPaused()).toBe(false);
    expect(coverTrafficGridPaginationDepth()).toBe(0);
  });

  it('does not leak hold depth when overlapping browse fetches end out of order', () => {
    coverTrafficBeginGridPagination();
    coverTrafficBeginGridPagination();
    coverTrafficEndGridPagination();
    expect(coverTrafficGridPaginationDepth()).toBe(1);
    coverTrafficEndGridPagination();
    expect(coverTrafficGridPaginationDepth()).toBe(0);
  });
});
