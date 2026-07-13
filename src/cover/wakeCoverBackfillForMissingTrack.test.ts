import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wakeCoverBackfillForMissingTrack } from '@/cover/wakeCoverBackfillForMissingTrack';
import { wakeLibraryCoverBackfill } from '@/lib/library/coverBackfillWake';
import { useAuthStore } from '@/store/authStore';
import { useCoverStrategyStore } from '@/store/coverStrategyStore';

vi.mock('@/lib/library/coverBackfillWake', () => ({
  wakeLibraryCoverBackfill: vi.fn(),
}));

describe('wakeCoverBackfillForMissingTrack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.mocked(wakeLibraryCoverBackfill).mockClear();
    useAuthStore.setState({
      activeServerId: 'srv-1',
      servers: [{
        id: 'srv-1',
        name: 'Test',
        url: 'http://music.example',
        username: 'u',
        password: 'p',
      }],
    });
    useCoverStrategyStore.setState({ strategy: 'aggressive', strategyByServer: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('wakes backfill when albumId is missing', () => {
    wakeCoverBackfillForMissingTrack({ albumId: '', coverArt: 'cv1' });
    expect(wakeLibraryCoverBackfill).toHaveBeenCalledTimes(1);
  });

  it('does not wake when albumId alone resolves a fetch id', () => {
    vi.setSystemTime(10_000);
    wakeCoverBackfillForMissingTrack({ albumId: 'al-1', coverArt: '' });
    expect(wakeLibraryCoverBackfill).not.toHaveBeenCalled();
  });

  it('does not wake for per-track mf-* when albumId resolves fetch', () => {
    vi.setSystemTime(15_000);
    wakeCoverBackfillForMissingTrack({ albumId: 'al-1', coverArt: 'mf-track123' });
    expect(wakeLibraryCoverBackfill).not.toHaveBeenCalled();
  });

  it('does not wake when both albumId and coverArt are present', () => {
    vi.setSystemTime(20_000);
    wakeCoverBackfillForMissingTrack({ albumId: 'al-1', coverArt: 'cv1' });
    expect(wakeLibraryCoverBackfill).not.toHaveBeenCalled();
  });

  it('does not wake under lazy cover strategy', () => {
    vi.setSystemTime(30_000);
    useCoverStrategyStore.setState({ strategy: 'lazy', strategyByServer: {} });
    wakeCoverBackfillForMissingTrack({ albumId: '', coverArt: '' });
    expect(wakeLibraryCoverBackfill).not.toHaveBeenCalled();
  });
});
