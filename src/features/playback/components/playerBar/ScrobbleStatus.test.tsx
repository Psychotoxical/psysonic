import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';
import { emitPlaybackProgress } from '@/features/playback/store/playbackProgress';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import i18n from '@/lib/i18n';
import { ScrobbleActionButton, ScrobbleStatus } from './ScrobbleStatus';

const isOfflineBrowseActive = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/features/offline/utils/offlineBrowseMode', () => ({
  isOfflineBrowseActive,
  useOfflineBrowseActive: () => isOfflineBrowseActive(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetAllStores();
  isOfflineBrowseActive.mockReturnValue(false);
  const track = makeTrack({ duration: 100 });
  seedQueue([track], { index: 0, currentTrack: track });
  usePlayerStore.setState({ scrobbled: false });
  useAuthStore.setState({ scrobbleThresholdPercent: 50 });
  emitPlaybackProgress({ currentTime: 20, progress: 0.2, buffered: 0, buffering: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScrobbleStatus', () => {
  it('uses SendHorizontal before submission and BadgeCheck afterward', () => {
    const { container, rerender } = renderWithProviders(
      <ScrobbleActionButton t={i18n.t} className="player-btn" />,
    );
    expect(container.querySelector('.lucide-send-horizontal')).toBeInTheDocument();
    expect(container.querySelector('.lucide-badge-check')).toBeNull();

    act(() => usePlayerStore.setState({ scrobbled: true }));
    rerender(<ScrobbleActionButton t={i18n.t} className="player-btn" />);
    expect(container.querySelector('.lucide-send-horizontal')).toBeNull();
    expect(container.querySelector('.lucide-badge-check')).toBeInTheDocument();
  });

  it('opens on hover and force-scrobbles the current track', () => {
    const force = vi.fn(() => true);
    usePlayerStore.setState({ forceScrobbleCurrentTrack: force });
    const { getByLabelText, getByRole } = renderWithProviders(
      <ScrobbleStatus minuteFieldWidth={4} t={i18n.t} />,
    );

    fireEvent.mouseEnter(getByLabelText('Scrobble status'));
    act(() => { vi.advanceTimersByTime(500); });
    expect(getByRole('dialog', { name: 'Scrobble status' })).toBeInTheDocument();
    expect(getByRole('dialog').textContent).toContain('20% of 50%');

    fireEvent.click(getByRole('button', { name: 'Force scrobble' }));
    expect(force).toHaveBeenCalledTimes(1);
  });

  it('hides Force scrobble after the play-through is already submitted', () => {
    usePlayerStore.setState({ scrobbled: true });
    const { getByLabelText, queryByRole, getByText } = renderWithProviders(
      <ScrobbleStatus minuteFieldWidth={4} t={i18n.t} />,
    );
    fireEvent.focus(getByLabelText('Scrobble status'));
    expect(queryByRole('button', { name: 'Force scrobble' })).toBeNull();
    expect(getByText('Already scrobbled')).toBeInTheDocument();
  });

  it('hides Force scrobble while offline browse is active', () => {
    isOfflineBrowseActive.mockReturnValue(true);
    const { getByLabelText, queryByRole, getByText } = renderWithProviders(
      <ScrobbleStatus minuteFieldWidth={4} t={i18n.t} />,
    );
    fireEvent.focus(getByLabelText('Scrobble status'));
    expect(queryByRole('button', { name: 'Force scrobble' })).toBeNull();
    expect(getByText('Unavailable while offline')).toBeInTheDocument();
  });
});
