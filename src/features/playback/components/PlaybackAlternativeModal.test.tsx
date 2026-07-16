import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlaybackAlternativeModal from '@/features/playback/components/PlaybackAlternativeModal';
import {
  _resetPlaybackAlternativeStoreForTest,
  usePlaybackAlternativeStore,
} from '@/features/playback/store/playbackAlternativeStore';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

describe('PlaybackAlternativeModal accessibility', () => {
  beforeEach(_resetPlaybackAlternativeStoreForTest);

  it('focuses the close action, contains Tab, closes on Escape, and restores focus', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <button type="button">Playback retry trigger</button>
        <PlaybackAlternativeModal />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Playback retry trigger' });
    trigger.focus();
    usePlaybackAlternativeStore.setState({
      isOpen: true,
      status: 'empty',
      detail: 'Original source failed',
    });

    const close = await screen.findByRole('button', { name: 'Close playback source choices' });
    await waitFor(() => expect(close).toHaveFocus());
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('uses viewport-safe structural classes on the dialog card', () => {
    usePlaybackAlternativeStore.setState({ isOpen: true, status: 'empty' });
    renderWithProviders(<PlaybackAlternativeModal />);

    expect(screen.getByRole('dialog')).toHaveClass('playback-alternative-modal');
    expect(screen.getByRole('dialog').parentElement).toHaveClass('playback-alternative-overlay');
  });
});
