import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

vi.mock('@/ui/CachedImage', async () => {
  const actual = await vi.importActual<typeof import('@/ui/CachedImage')>('@/ui/CachedImage');
  return { ...actual, useCachedUrl: vi.fn((url: string) => (url ? `mock://${url}` : '')) };
});
vi.mock('@/features/visualizer', () => ({
  VisualizerPanel: ({ paused }: { paused?: boolean }) => (
    <div role="region" aria-label="Visualizer" data-paused={paused ? 'true' : 'false'} />
  ),
}));

import FullscreenPlayerPrism from './FullscreenPlayerPrism';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack } from '@/test/helpers/factories';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';
import { TRANSIENT_UI_OPEN_EVENT } from '@/lib/dom/transientUi';

beforeEach(() => {
  resetAllStores();
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  useAuthStore.setState({ fullscreenPlayerStyle: 'prism' });
  registerDefaultCoverInvokeHandlers();
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_set_volume', () => undefined);
});

describe('FullscreenPlayerPrism', () => {
  it('renders the labelled fullscreen dialog and close button', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const { getByLabelText } = renderWithProviders(<FullscreenPlayerPrism onClose={() => {}} />);
    expect(getByLabelText('Fullscreen Player')).toBeInTheDocument();
    expect(getByLabelText('Close Fullscreen')).toBeInTheDocument();
    expect(getByLabelText('Visualizer')).toBeInTheDocument();
    expect(
      getByLabelText('Seek').closest('[data-visualizer-overlay-exempt="fullscreen"]'),
    ).not.toBeNull();
  });

  it('clicking Close calls the onClose prop', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const onClose = vi.fn();
    const { getByLabelText } = renderWithProviders(<FullscreenPlayerPrism onClose={onClose} />);
    fireEvent.click(getByLabelText('Close Fullscreen'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking an artist link closes the fullscreen player', () => {
    usePlayerStore.setState({
      currentTrack: makeTrack({
        artist: 'Primary feat. Guest',
        artistId: 'primary-id',
        artists: [{ id: 'primary-id', name: 'Primary' }, { id: 'guest-id', name: 'Guest' }],
      }),
    });
    const onClose = vi.fn();
    const { getByRole } = renderWithProviders(<FullscreenPlayerPrism onClose={onClose} />);
    fireEvent.click(getByRole('link', { name: 'Guest' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the volume button mutes the player', () => {
    usePlayerStore.setState({ currentTrack: makeTrack(), volume: 0.7 });
    const { getByLabelText } = renderWithProviders(<FullscreenPlayerPrism onClose={() => {}} />);
    fireEvent.click(getByLabelText('Mute'));
    expect(usePlayerStore.getState().volume).toBe(0);
  });

  it('announces before opening the queue overlay', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const onTransientOpen = vi.fn();
    window.addEventListener(TRANSIENT_UI_OPEN_EVENT, onTransientOpen);
    const { getByLabelText } = renderWithProviders(<FullscreenPlayerPrism onClose={() => {}} />);

    fireEvent.click(getByLabelText('Queue'));

    expect(onTransientOpen).toHaveBeenCalledTimes(1);
    window.removeEventListener(TRANSIENT_UI_OPEN_EVENT, onTransientOpen);
  });
});
