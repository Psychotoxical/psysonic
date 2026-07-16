import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  createInternetRadioStationForServer,
  getTopRadioStations,
} from '@/lib/api/subsonicRadio';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import RadioDirectoryModal from './RadioDirectoryModal';

vi.mock('@/lib/api/subsonicRadio', () => ({
  createInternetRadioStationForServer: vi.fn(),
  fetchUrlBytes: vi.fn(),
  getInternetRadioStationsForServer: vi.fn(),
  getTopRadioStations: vi.fn(),
  searchRadioBrowser: vi.fn(),
  uploadRadioCoverArtBytesForServer: vi.fn(),
}));

vi.mock('@/lib/dom/toast', () => ({ showToast: vi.fn() }));

const station = {
  stationuuid: 'station-1',
  name: 'Test FM',
  url: 'https://radio.test/stream',
  favicon: '',
  tags: 'rock,pop',
};

describe('RadioDirectoryModal accessibility', () => {
  beforeEach(() => {
    vi.mocked(getTopRadioStations).mockResolvedValue([station]);
    vi.mocked(createInternetRadioStationForServer).mockResolvedValue(undefined);
  });

  it('manages dialog focus, traps Tab, closes on Escape, and restores the trigger', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Browse radio trigger</button>
          {open ? (
            <RadioDirectoryModal
              sources={[{ serverId: 'home', label: 'Home' }]}
              onClose={() => { onClose(); setOpen(false); }}
              onAdded={vi.fn()}
            />
          ) : null}
        </>
      );
    }
    renderWithProviders(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Browse radio trigger' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Search Directory' });
    const search = screen.getByPlaceholderText('Search stations…');
    await waitFor(() => expect(search).toHaveFocus());
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const result = await screen.findByRole('button', { name: /Test FM/i });
    result.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('adds a directory result through its semantic button keyboard behavior', async () => {
    const user = userEvent.setup();
    const onAdded = vi.fn();
    renderWithProviders(
      <RadioDirectoryModal
        sources={[{ serverId: 'home', label: 'Home' }]}
        onClose={vi.fn()}
        onAdded={onAdded}
      />,
    );

    const result = await screen.findByRole('button', { name: /Test FM/i });
    result.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(createInternetRadioStationForServer).toHaveBeenCalledWith(
      'home',
      'Test FM',
      'https://radio.test/stream',
    ));
    expect(onAdded).toHaveBeenCalledWith('home');
  });
});
