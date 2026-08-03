import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/ui/CachedImage', async () => {
  const actual = await vi.importActual<typeof import('@/ui/CachedImage')>('@/ui/CachedImage');
  return { ...actual, useCachedUrl: vi.fn((url: string) => (url ? `mock://${url}` : '')) };
});
vi.mock('@/features/visualizer/components/VisualizerCanvas', () => ({
  default: () => <canvas data-testid="visualizer-canvas" />,
}));
vi.mock('@/features/visualizer/hooks/useVisualizerCoverArt', () => ({
  useVisualizerCoverArt: () => ({ artUrl: '', artKey: '' }),
}));

import FullscreenPlayerPrism from './FullscreenPlayerPrism';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useVisualizerStore } from '@/features/visualizer';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack } from '@/test/helpers/factories';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';

function PrismHarness() {
  const [open, setOpen] = useState(true);
  return open ? <FullscreenPlayerPrism onClose={() => setOpen(false)} /> : null;
}

beforeEach(() => {
  resetAllStores();
  useVisualizerStore.setState({ enabled: true, mode: 'bars', expandedSurface: null });
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  useAuthStore.setState({ fullscreenPlayerStyle: 'prism' });
  usePlayerStore.setState({ currentTrack: makeTrack(), isPlaying: false });
  registerDefaultCoverInvokeHandlers();
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_set_volume', () => undefined);
});

describe('FullscreenPlayerPrism visualizer integration', () => {
  it('releases fullscreen expansion when the player closes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PrismHarness />);

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    expect(useVisualizerStore.getState().expandedSurface).toBe('fullscreen');

    await user.click(screen.getByRole('button', { name: 'Close Fullscreen' }));

    await waitFor(() => expect(useVisualizerStore.getState().expandedSurface).toBeNull());
  });

  it('skips the responsive seek control when its Prism pill is hidden', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PrismHarness />);
    const pill = document.querySelector<HTMLElement>('.fsp2-pill');
    expect(pill).not.toBeNull();
    pill!.style.display = 'none';

    await user.click(screen.getByRole('button', { name: 'Fill the window' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exit full window' })).toHaveFocus());

    for (const name of ['Previous Track', 'Play', 'Next Track', 'Repeat']) {
      await user.tab();
      expect(screen.getByRole('button', { name })).toHaveFocus();
    }
    await user.tab();
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveFocus();
    expect(document.querySelector<HTMLInputElement>('.fsp2-progress input')).not.toHaveFocus();
  });
});
