import { act, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  fetchGenreCatalog: vi.fn(),
  fetchRandomMixSongsUntilFull: vi.fn(),
}));

vi.mock('@/features/playback/utils/playback/genreBrowsePlayback', () => ({
  fetchGenreCatalog: hoisted.fetchGenreCatalog,
}));

vi.mock('@/features/playback/utils/mixRatingFilter', () => ({
  fetchRandomMixSongsUntilFull: hoisted.fetchRandomMixSongsUntilFull,
  getMixMinRatingsConfigFromAuth: vi.fn(() => ({ enabled: false })),
}));

vi.mock('@/features/orbit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/orbit')>(),
  useOrbitSongRowBehavior: () => ({
    orbitActive: false,
    queueHint: null,
    addTrackToOrbit: vi.fn(),
  }),
}));

vi.mock('@/lib/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/features/randomMix/components/RandomMixFiltersPanel', () => ({ default: () => null }));
vi.mock('@/features/randomMix/components/RandomMixTrackRow', () => ({ default: () => null }));
vi.mock('@/features/randomMix/components/RandomMixHeader', () => ({
  default: ({ selectedGenre }: { selectedGenre: string | null }) => (
    <div data-testid="selected-genre">{selectedGenre ?? 'all'}</div>
  ),
}));
vi.mock('@/features/randomMix/components/RandomMixGenrePanel', () => ({
  default: ({ onSelectGenre }: { onSelectGenre: (genre: string) => void }) => (
    <button type="button" onClick={() => onSelectGenre('Rock')}>Rock</button>
  ),
}));

import RandomMix from '@/features/randomMix/pages/RandomMix';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

describe('RandomMix', () => {
  beforeEach(() => {
    resetAllStores();
    hoisted.fetchGenreCatalog.mockReset().mockResolvedValue([
      { value: 'Rock', songCount: 1, albumCount: 1 },
    ]);
    hoisted.fetchRandomMixSongsUntilFull.mockReset().mockResolvedValue([]);
    useAuthStore.setState({
      activeServerId: 'srv-a',
      servers: [
        { id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
        { id: 'srv-b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
      ],
    });
  });

  it('returns to the all-genres mix when the active server changes', async () => {
    const view = renderWithProviders(<RandomMix />);
    await waitFor(() => expect(hoisted.fetchGenreCatalog).toHaveBeenCalledWith('srv-a', true));

    fireEvent.click(view.getByRole('button', { name: 'Rock' }));
    expect(view.getByTestId('selected-genre')).toHaveTextContent('Rock');

    act(() => useAuthStore.setState({ activeServerId: 'srv-b' }));

    await waitFor(() => expect(view.getByTestId('selected-genre')).toHaveTextContent('all'));
    expect(hoisted.fetchGenreCatalog).toHaveBeenCalledWith('srv-b', true);
  });
});
