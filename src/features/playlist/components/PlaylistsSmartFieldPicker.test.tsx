import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import PlaylistsSmartFieldPicker from '@/features/playlist/components/PlaylistsSmartFieldPicker';
import { resolveSmartPlaylistCapabilities } from '@/features/playlist/utils/smartPlaylistFields';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

describe('PlaylistsSmartFieldPicker', () => {
  it('filters the field list as the user types', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = renderWithProviders(
      <PlaylistsSmartFieldPicker
        value="title"
        capabilities={resolveSmartPlaylistCapabilities('0.63.2')}
        customFields={[]}
        onChange={onChange}
      />,
    );

    const input = view.getByRole('combobox', { name: 'Field' });
    await user.click(input);
    await user.type(input, 'mood');
    expect(view.getByRole('option', { name: 'Mood' })).toBeInTheDocument();
    expect(view.queryByRole('option', { name: 'Title' })).not.toBeInTheDocument();

    await user.click(view.getByRole('option', { name: /mood/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ name: 'mood' }));
  });

  it('includes Playlist in filter fields and Random only when sorting', async () => {
    const user = userEvent.setup();
    const capabilities = resolveSmartPlaylistCapabilities('0.63.2');
    const filterView = renderWithProviders(
      <PlaylistsSmartFieldPicker
        value="title"
        capabilities={capabilities}
        customFields={[]}
        onChange={vi.fn()}
      />,
    );

    await user.click(filterView.getByRole('combobox', { name: 'Field' }));
    expect(filterView.getByRole('option', { name: 'Playlist' })).toBeInTheDocument();
    expect(filterView.queryByRole('option', { name: 'Random' })).not.toBeInTheDocument();
    filterView.unmount();

    const sortView = renderWithProviders(
      <PlaylistsSmartFieldPicker
        value="title"
        capabilities={capabilities}
        customFields={[]}
        onChange={vi.fn()}
        sortableOnly
      />,
    );
    await user.click(sortView.getByRole('combobox', { name: 'Field' }));
    expect(sortView.getByRole('option', { name: 'Random' })).toBeInTheDocument();
    expect(sortView.queryByRole('option', { name: 'Playlist' })).not.toBeInTheDocument();
  });
});
