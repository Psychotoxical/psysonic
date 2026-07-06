import { describe, expect, it } from 'vitest';
import { tracksBrowseDiscoveryChromeHidden } from '@/features/search/utils/tracksBrowseDiscoveryChrome';

describe('tracksBrowseDiscoveryChromeHidden', () => {
  it('hides discovery chrome during offline local browse', () => {
    expect(tracksBrowseDiscoveryChromeHidden({
      offlineBrowseActive: true,
      tracksSearchActive: false,
      leaveRestorePendingWithQuery: false,
    })).toBe(true);
  });

  it('shows discovery chrome when online and not searching', () => {
    expect(tracksBrowseDiscoveryChromeHidden({
      offlineBrowseActive: false,
      tracksSearchActive: false,
      leaveRestorePendingWithQuery: false,
    })).toBe(false);
  });

  it('hides discovery chrome during active track text search', () => {
    expect(tracksBrowseDiscoveryChromeHidden({
      offlineBrowseActive: false,
      tracksSearchActive: true,
      leaveRestorePendingWithQuery: false,
    })).toBe(true);
  });
});
