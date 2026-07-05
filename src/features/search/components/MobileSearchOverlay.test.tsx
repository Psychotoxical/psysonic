import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import MobileSearchOverlay from '@/features/search/components/MobileSearchOverlay';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';

// The overlay's only behaviour-bearing change in PR #1165 was renaming the
// recent-search handler `useRecent` → `applyRecentSearch` (it was a plain
// function mis-flagged as a hook). Smoke-test that the recent-search path still
// applies the term to the live-search store. Heavy collaborators are stubbed.
vi.mock('@/features/search/hooks/useShareSearch', () => ({ useShareSearch: () => ({ shareMatch: null }) }));
vi.mock('@/lib/api/subsonicSearch', () => ({
  search: vi.fn(() => Promise.resolve({ artists: [], albums: [], songs: [] })),
}));
vi.mock('@/cover/AlbumCoverArtImage', () => ({ AlbumCoverArtImage: () => null }));
vi.mock('@/cover/ArtistCoverArtImage', () => ({ ArtistCoverArtImage: () => null }));
vi.mock('@/cover/CoverArtImage', () => ({ CoverArtImage: () => null }));

const RECENT_KEY = 'psysonic_recent_searches';

describe('MobileSearchOverlay — recent search (applyRecentSearch, PR #1165)', () => {
  beforeEach(() => {
    useLiveSearchScopeStore.setState({ query: '', scope: null, undoStack: [] });
    localStorage.setItem(RECENT_KEY, JSON.stringify(['first query', 'second query']));
  });

  it('lists stored recent searches in the empty state', () => {
    renderWithProviders(<MobileSearchOverlay onClose={vi.fn()} />);
    expect(screen.getByText('first query')).toBeInTheDocument();
    expect(screen.getByText('second query')).toBeInTheDocument();
  });

  it('applies a recent search term to the live-search store on click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MobileSearchOverlay onClose={vi.fn()} />);

    await user.click(screen.getByText('first query'));

    expect(useLiveSearchScopeStore.getState().query).toBe('first query');
  });
});
