// The banner icon shipped with a `viewBox` but no width/height and no CSS rule
// for its class, so it had no intrinsic size at all. WebKitGTK happened to
// render it small; Chromium (WebView2, i.e. Windows) fell back to the 300x150
// default replaced-element size and the icon swallowed the bar. Pin the explicit
// dimensions — CSS alone cannot be asserted here, and the attributes are what
// make the icon correct even before the stylesheet applies.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import DiscordBanner from './DiscordBanner';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

const THRESHOLD_MS = 20 * 60 * 60 * 1000;

describe('DiscordBanner', () => {
  beforeEach(() => {
    resetAuthStore();
    useAuthStore.setState({ discordBannerAccumulatedUsageMs: THRESHOLD_MS });
  });
  afterEach(resetAuthStore);

  it('sizes its icon explicitly instead of leaving it intrinsic', () => {
    const { container } = render(<DiscordBanner />);
    const icon = container.querySelector('.discord-banner-icon');

    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('width')).toBe('18');
    expect(icon?.getAttribute('height')).toBe('18');
  });

  it('keeps the icon inside the banner row next to the message and join button', () => {
    const { container } = render(<DiscordBanner />);
    const left = container.querySelector('.discord-banner-left');

    expect(left?.querySelector('.discord-banner-icon')).not.toBeNull();
    expect(left?.querySelector('.discord-banner-text')).not.toBeNull();
    expect(left?.querySelector('.discord-banner-join')).not.toBeNull();
  });
});
