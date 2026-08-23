import { describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import PlaylistsSmartValuePicker from '@/features/playlist/components/PlaylistsSmartValuePicker';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

describe('PlaylistsSmartValuePicker', () => {
  it('filters options and commits a match', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = renderWithProviders(
      <PlaylistsSmartValuePicker
        value=""
        options={[
          { value: 'Rock', label: 'Rock' },
          { value: 'Jazz', label: 'Jazz' },
        ]}
        onChange={onChange}
        ariaLabel="Value"
      />,
    );

    const input = view.getByRole('combobox', { name: 'Value' });
    await user.click(input);
    await user.type(input, 'ja');
    expect(view.getByRole('option', { name: 'Jazz' })).toBeInTheDocument();
    expect(view.queryByRole('option', { name: 'Rock' })).not.toBeInTheDocument();
    await user.click(view.getByRole('option', { name: 'Jazz' }));
    expect(onChange).toHaveBeenCalledWith('Jazz');
  });

  it('keeps free text when Enter is pressed without a match', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = renderWithProviders(
      <PlaylistsSmartValuePicker
        value=""
        options={[{ value: 'Rock', label: 'Rock' }]}
        onChange={onChange}
        ariaLabel="Value"
      />,
    );

    const input = view.getByRole('combobox', { name: 'Value' });
    await user.click(input);
    await user.type(input, 'Shoegaze{Enter}');
    expect(onChange).toHaveBeenCalledWith('Shoegaze');
  });
});
