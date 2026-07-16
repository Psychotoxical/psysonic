import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import RadioEditModal from './RadioEditModal';

describe('RadioEditModal', () => {
  it('requires an explicit source when more than one server can create stations', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    renderWithProviders(
      <RadioEditModal
        station={null}
        sources={[
          { serverId: 'home', label: 'alice@music.test' },
          { serverId: 'office', label: 'bob@office.test' },
        ]}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );

    await user.type(screen.getByPlaceholderText('Station name…'), 'Test FM');
    await user.type(screen.getByPlaceholderText('Stream URL…'), 'https://radio.test/stream');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Radio source' }), 'office');
    await user.click(save);

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'office',
      name: 'Test FM',
      streamUrl: 'https://radio.test/stream',
    }));
  });
});
