import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

vi.mock('@/ui/CachedImage', async () => {
  const actual = await vi.importActual<typeof import('@/ui/CachedImage')>('@/ui/CachedImage');
  return { ...actual, useCachedUrl: vi.fn((url: string) => (url ? `mock://${url}` : '')) };
});

import FullscreenPlayerImmersive from './FullscreenPlayerImmersive';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack } from '@/test/helpers/factories';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';

beforeEach(() => {
  resetAllStores();
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  useAuthStore.setState({ fullscreenPlayerStyle: 'immersive' });
  registerDefaultCoverInvokeHandlers();
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
});

describe('FullscreenPlayerImmersive', () => {
  it('renders the labelled fullscreen dialog and close button', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const { getByLabelText } = renderWithProviders(<FullscreenPlayerImmersive onClose={() => {}} />);
    expect(getByLabelText('Fullscreen Player')).toBeInTheDocument();
    expect(getByLabelText('Close Fullscreen')).toBeInTheDocument();
  });

  it('clicking Close calls the onClose prop', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const onClose = vi.fn();
    const { getByLabelText } = renderWithProviders(<FullscreenPlayerImmersive onClose={onClose} />);
    fireEvent.click(getByLabelText('Close Fullscreen'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking Stop calls the player store stop()', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const stopSpy = vi.spyOn(usePlayerStore.getState(), 'stop');
    const { getByLabelText } = renderWithProviders(<FullscreenPlayerImmersive onClose={() => {}} />);
    fireEvent.click(getByLabelText('Stop'));
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
