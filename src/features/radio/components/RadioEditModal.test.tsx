import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import RadioEditModal from '@/features/radio/components/RadioEditModal';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

const SERVER_OPTIONS = [
  { id: 'srv-a', label: 'Server A' },
  { id: 'srv-b', label: 'Server B' },
];

describe('RadioEditModal', () => {
  it('selects the owner server inside the add-station modal', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {});
    const view = renderWithProviders(
      <RadioEditModal
        station={null}
        initialServerId="srv-a"
        serverOptions={SERVER_OPTIONS}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const serverSelect = view.getByRole('combobox', { name: 'Servers' });
    expect(serverSelect).toHaveTextContent('Server A');
    await user.click(serverSelect);
    await user.click(view.getByRole('option', { name: 'Server B' }));
    await user.type(view.getByRole('textbox', { name: /Station name/ }), 'New station');
    await user.type(view.getByRole('textbox', { name: /Stream URL/ }), 'https://radio.test/live');
    await user.click(view.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'srv-b',
      name: 'New station',
      streamUrl: 'https://radio.test/live',
    }));
  });

  it('hides the owner selector when only one server is available', () => {
    const view = renderWithProviders(
      <RadioEditModal
        station={null}
        initialServerId="srv-a"
        serverOptions={[SERVER_OPTIONS[0]]}
        onClose={vi.fn()}
        onSave={vi.fn(async () => {})}
      />,
    );

    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });

  it('keeps the owner fixed while editing an existing station', () => {
    const view = renderWithProviders(
      <RadioEditModal
        station={{
          id: 'station-1',
          serverId: 'srv-a',
          name: 'Existing station',
          streamUrl: 'https://radio.test/existing',
        }}
        initialServerId="srv-a"
        serverOptions={SERVER_OPTIONS}
        onClose={vi.fn()}
        onSave={vi.fn(async () => {})}
      />,
    );

    expect(view.queryByRole('combobox', { name: 'Servers' })).not.toBeInTheDocument();
  });
});
