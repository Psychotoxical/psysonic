import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { useAuthStore } from '@/store/authStore';
import { SmartPlaylistCustomFieldsSection } from './SmartPlaylistCustomFieldsSection';

describe('SmartPlaylistCustomFieldsSection', () => {
  it('persists a custom field on the Library settings list', async () => {
    useAuthStore.getState().setSmartPlaylistCustomFields([]);
    const user = userEvent.setup();
    const view = renderWithProviders(<SmartPlaylistCustomFieldsSection defaultOpen />);

    await user.type(view.getByPlaceholderText('Field name'), 'ndmood_energy');
    await user.click(view.getByRole('button', { name: 'Add custom field' }));

    expect(useAuthStore.getState().smartPlaylistCustomFields).toEqual([
      { name: 'ndmood_energy', type: 'string', kind: 'tag' },
    ]);
    expect(view.getByText('ndmood_energy')).toBeInTheDocument();
  });
});
