import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import GenreFilterBar from './GenreFilterBar';

vi.mock('@/lib/api/subsonicGenres', () => ({
  getGenres: vi.fn(),
}));

import { getGenres } from '@/lib/api/subsonicGenres';

describe('GenreFilterBar', () => {
  it('does not replace a pending scoped catalog with server-wide counts', () => {
    renderWithProviders(
      <GenreFilterBar selected={[]} onSelectionChange={vi.fn()} catalogGenres={null} />,
    );

    expect(getGenres).not.toHaveBeenCalled();
  });
});
