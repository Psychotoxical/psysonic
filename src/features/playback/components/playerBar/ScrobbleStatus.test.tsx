import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';
import { emitPlaybackProgress } from '@/features/playback/store/playbackProgress';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePreviewStore } from '@/features/playback/store/previewStore';
import { useAuthStore } from '@/store/authStore';
import i18n from '@/lib/i18n';
import { ScrobbleActionButton } from './ScrobbleStatus';

const forceScrobbleCurrentTrack = vi.hoisted(() => vi.fn(() => true));
const useOfflineBrowseActive = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/features/playback/store/scrobbleActions', () => ({
  forceScrobbleCurrentTrack,
}));

vi.mock('@/features/offline', () => ({
  useOfflineBrowseActive,
  offlineActionPolicy: (_surface: string, offline: boolean) => ({ canScrobble: !offline }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetAllStores();
  forceScrobbleCurrentTrack.mockClear();
  useOfflineBrowseActive.mockReturnValue(false);
  const track = makeTrack({ duration: 100 });
  seedQueue([track], { index: 0, currentTrack: track });
  usePlayerStore.setState({ scrobbled: false });
  useAuthStore.setState({
    forceScrobbleEnabled: true,
    scrobbleThresholdPercent: 50,
  });
  emitPlaybackProgress({ currentTime: 20, progress: 0.2, buffered: 0, buffering: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScrobbleActionButton', () => {
  it('is hidden until the advanced control is enabled', () => {
    useAuthStore.setState({ forceScrobbleEnabled: false });
    const { container } = renderWithProviders(
      <ScrobbleActionButton t={i18n.t} className="player-btn" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('uses SendHorizontal before submission and BadgeCheck afterward', () => {
    const { container } = renderWithProviders(
      <ScrobbleActionButton t={i18n.t} className="player-btn" />,
    );
    expect(container.querySelector('.lucide-send-horizontal')).toBeInTheDocument();

    act(() => usePlayerStore.setState({ scrobbled: true }));
    expect(container.querySelector('.lucide-badge-check')).toBeInTheDocument();
  });

  it('opens on click, shows progress, and force-scrobbles the current track', () => {
    const { getByRole } = renderWithProviders(
      <ScrobbleActionButton t={i18n.t} className="player-btn" />,
    );

    fireEvent.click(getByRole('button', { name: 'Force scrobble' }));
    const dialog = getByRole('dialog', { name: 'Scrobble status' });
    expect(dialog).toHaveTextContent('20% of 50%');

    fireEvent.click(dialog.querySelector('.player-scrobble-popover__force')!);
    expect(forceScrobbleCurrentTrack).toHaveBeenCalledWith(true);
  });

  it('moves focus into the popover and restores it on Escape', () => {
    const { getByRole } = renderWithProviders(
      <ScrobbleActionButton t={i18n.t} className="player-btn" />,
    );
    const trigger = getByRole('button', { name: 'Force scrobble' });

    fireEvent.click(trigger);
    const dialog = getByRole('dialog', { name: 'Scrobble status' });
    const forceButton = dialog.querySelector('.player-scrobble-popover__force');
    expect(forceButton).toHaveFocus();

    fireEvent.keyDown(forceButton!, { key: 'Tab' });
    expect(forceButton).toHaveFocus();
    fireEvent.keyDown(forceButton!, { key: 'Tab', shiftKey: true });
    expect(forceButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });

  it('executes directly in compact overflow mode without opening a nested popover', () => {
    const onDirectAction = vi.fn();
    const { getByRole, queryByRole } = renderWithProviders(
      <ScrobbleActionButton
        t={i18n.t}
        className="player-btn"
        direct
        onDirectAction={onDirectAction}
      />,
    );

    fireEvent.click(getByRole('button', { name: 'Force scrobble' }));
    expect(forceScrobbleCurrentTrack).toHaveBeenCalledWith(true);
    expect(onDirectAction).toHaveBeenCalledOnce();
    expect(queryByRole('dialog')).toBeNull();
  });

  it('explains why force scrobble is unavailable offline', () => {
    useOfflineBrowseActive.mockReturnValue(true);
    const { getByRole, queryByRole, getByText } = renderWithProviders(
      <ScrobbleActionButton t={i18n.t} className="player-btn" />,
    );
    fireEvent.click(getByRole('button', { name: 'Unavailable while offline' }));
    expect(queryByRole('button', { name: 'Force scrobble' })).toBeNull();
    expect(getByText('Unavailable while offline')).toHaveFocus();
  });

  it('uses localized preview copy instead of exposing the translation key', () => {
    usePreviewStore.setState({ previewingId: 'preview-track' });
    const { getByRole, getByText } = renderWithProviders(
      <ScrobbleActionButton t={i18n.t} className="player-btn" />,
    );

    fireEvent.click(getByRole('button', { name: 'Unavailable during track preview' }));
    expect(getByText('Unavailable during track preview')).toHaveFocus();
  });

  it('keeps a blocked compact action inert and does not close its overflow menu', () => {
    useOfflineBrowseActive.mockReturnValue(true);
    const onDirectAction = vi.fn();
    const { getByRole } = renderWithProviders(
      <ScrobbleActionButton
        t={i18n.t}
        className="player-btn"
        direct
        onDirectAction={onDirectAction}
      />,
    );
    const button = getByRole('button', { name: 'Unavailable while offline' });

    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);

    expect(forceScrobbleCurrentTrack).not.toHaveBeenCalled();
    expect(onDirectAction).not.toHaveBeenCalled();
  });
});
