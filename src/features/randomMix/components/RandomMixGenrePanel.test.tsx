import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import RandomMixGenrePanel from '@/features/randomMix/components/RandomMixGenrePanel';

describe('RandomMixGenrePanel', () => {
  it('exposes genre chips as independent toggle buttons', async () => {
    const user = userEvent.setup();
    const onSelectAll = vi.fn();
    const onToggleGenre = vi.fn();

    renderWithProviders(
      <RandomMixGenrePanel
        isMobile={false}
        genreMixExpanded
        setGenreMixExpanded={vi.fn()}
        genresLoading={false}
        serverGenresLength={2}
        displayedGenres={['Rock', 'Jazz']}
        allAvailableGenresLength={2}
        selectedGenres={['Rock']}
        genreMixLoading={false}
        onSelectAll={onSelectAll}
        onToggleGenre={onToggleGenre}
        onShuffle={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'All Songs' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Rock' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Jazz' })).toHaveAttribute('aria-pressed', 'false');

    await user.click(screen.getByRole('button', { name: 'Jazz' }));
    expect(onToggleGenre).toHaveBeenCalledWith('Jazz');

    await user.click(screen.getByRole('button', { name: 'All Songs' }));
    expect(onSelectAll).toHaveBeenCalledOnce();
  });
});
