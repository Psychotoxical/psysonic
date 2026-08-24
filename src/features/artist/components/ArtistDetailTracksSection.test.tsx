import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const useArtistAllTracks = vi.hoisted(() => vi.fn());

vi.mock('@/features/artist/hooks/useArtistAllTracks', () => ({ useArtistAllTracks }));
vi.mock('@/features/artist/components/ArtistDetailTopTracks', () => ({
  default: () => <div data-testid="top-list" />,
}));
vi.mock('@/features/artist/components/ArtistAllTracksList', () => ({
  default: () => <div data-testid="all-list" />,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import ArtistDetailTracksSection from '@/features/artist/components/ArtistDetailTracksSection';

function renderSection() {
  return render(
    <ArtistDetailTracksSection
      topSongs={[]}
      topSongsLoading={false}
      albums={[]}
      marginTop="0"
      playTopSongWithContinuation={vi.fn()}
      scopes={[{ serverId: 'srv-1', libraryId: null }]}
      serverId="srv-1"
      artistId="ar-1"
      onPlayAllTracks={vi.fn()}
    />,
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('ArtistDetailTracksSection', () => {
  beforeEach(() => {
    useArtistAllTracks.mockReset().mockReturnValue({ tracks: [], loading: false, failed: false });
  });

  it('opens on the ranking', () => {
    renderSection();
    expect(screen.getByTestId('top-list')).toBeTruthy();
    expect(screen.queryByTestId('all-list')).toBeNull();
    expect(tab('artistDetail.tracksTabTop').getAttribute('aria-selected')).toBe('true');
  });

  // The whole point of the lazy fetch: visitors who never open the tab must not
  // pay for a full discography.
  it('leaves the full list disabled until its tab is opened', () => {
    renderSection();
    expect(useArtistAllTracks).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));

    fireEvent.click(tab('artistDetail.tracksTabAll'));
    expect(useArtistAllTracks).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('swaps the table and moves the selection', () => {
    renderSection();
    fireEvent.click(tab('artistDetail.tracksTabAll'));

    expect(screen.getByTestId('all-list')).toBeTruthy();
    expect(screen.queryByTestId('top-list')).toBeNull();
    expect(tab('artistDetail.tracksTabAll').getAttribute('aria-selected')).toBe('true');
    expect(tab('artistDetail.tracksTabTop').getAttribute('aria-selected')).toBe('false');
  });

  // A tab list is expected to be steppable with the arrow keys, and only the
  // selected tab takes a Tab stop.
  it('moves between tabs with the arrow keys', () => {
    renderSection();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(tab('artistDetail.tracksTabAll').getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(tab('artistDetail.tracksTabTop').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps a single tab stop on the selected tab', () => {
    renderSection();
    expect(tab('artistDetail.tracksTabTop').getAttribute('tabindex')).toBe('0');
    expect(tab('artistDetail.tracksTabAll').getAttribute('tabindex')).toBe('-1');
  });

  it('names the lossless variant on its own tab', () => {
    render(
      <ArtistDetailTracksSection
        topSongs={[]}
        topSongsLoading={false}
        albums={[]}
        marginTop="0"
        playTopSongWithContinuation={vi.fn()}
        losslessOnly
        scopes={[{ serverId: 'srv-1', libraryId: null }]}
        serverId="srv-1"
        artistId="ar-1"
        onPlayAllTracks={vi.fn()}
      />,
    );
    expect(tab('artistDetail.tracksTabLossless')).toBeTruthy();
  });

  // Dropping the picker from the DOM would let the right-aligned group re-centre,
  // so the tabs would visibly jump sideways on every switch.
  it('keeps the column picker in place on both tabs, hidden on the ranking', () => {
    const { container } = renderSection();
    const picker = () => container.querySelector('.artist-tracks-picker');

    expect(picker()).toBeTruthy();
    expect(picker()?.className).toContain('is-hidden');
    expect(picker()?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(tab('artistDetail.tracksTabAll'));
    expect(picker()).toBeTruthy();
    expect(picker()?.className).not.toContain('is-hidden');
    expect(picker()?.getAttribute('aria-hidden')).toBe('false');
  });

  // The menu renders into a portal on `body`, so hiding its button alone would
  // leave it hanging on screen with nothing to belong to.
  it('closes an open column menu when leaving the full list', () => {
    renderSection();
    fireEvent.click(tab('artistDetail.tracksTabAll'));
    fireEvent.click(screen.getByRole('button', { name: 'albumDetail.columns' }));
    expect(document.querySelector('.tracklist-col-picker-menu')).toBeTruthy();

    fireEvent.click(tab('artistDetail.tracksTabTop'));
    expect(document.querySelector('.tracklist-col-picker-menu')).toBeNull();
  });

  it('ties the panel to the selected tab for screen readers', () => {
    renderSection();
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('artist-tracks-tab-top');
    expect(tab('artistDetail.tracksTabTop').getAttribute('aria-controls')).toBe(panel.id);
  });
});
