import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PlaylistFilterToolbar from '@/features/playlist/components/PlaylistFilterToolbar';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

describe('PlaylistFilterToolbar default order', () => {
  it('represents natural sort as ID and keeps date-added separate', async () => {
    const user = userEvent.setup();
    const setSortKey = vi.fn();
    const setSortDir = vi.fn();
    const view = renderWithProviders(
      <PlaylistFilterToolbar
        filterText=""
        setFilterText={vi.fn()}
        sortKey="natural"
        sortDir="asc"
        setSortKey={setSortKey}
        setSortDir={setSortDir}
        setSortClickCount={vi.fn()}
      />,
    );

    await user.click(view.getByRole('button', { name: 'Sort tracks' }));
    expect(view.getByRole('option', { name: 'ID' })).toBeInTheDocument();
    expect(view.getByRole('option', { name: 'Date added (newest)' })).toBeInTheDocument();
    expect(view.getByRole('option', { name: 'Date added (oldest)' })).toBeInTheDocument();

    await user.click(view.getByRole('option', { name: 'Date added (oldest)' }));
    expect(setSortKey).toHaveBeenCalledWith('position');
    expect(setSortDir).toHaveBeenCalledWith('asc');
  });

  it('maps the default option back to natural order', async () => {
    const user = userEvent.setup();
    const setSortKey = vi.fn();
    const setSortDir = vi.fn();
    const view = renderWithProviders(
      <PlaylistFilterToolbar
        filterText=""
        setFilterText={vi.fn()}
        sortKey="position"
        sortDir="desc"
        setSortKey={setSortKey}
        setSortDir={setSortDir}
        setSortClickCount={vi.fn()}
      />,
    );

    await user.click(view.getByRole('button', { name: 'Sort tracks' }));
    await user.click(view.getByRole('option', { name: 'ID' }));
    expect(setSortKey).toHaveBeenCalledWith('natural');
    expect(setSortDir).toHaveBeenCalledWith('asc');
  });
});
