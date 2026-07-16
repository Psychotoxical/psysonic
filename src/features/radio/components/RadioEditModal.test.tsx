import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import RadioEditModal from './RadioEditModal';

describe('RadioEditModal', () => {
  it('manages dialog focus, closes on Escape, and restores the trigger', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Add radio trigger</button>
          {open ? (
            <RadioEditModal
              station={null}
              sources={[{ serverId: 'home', label: 'Home' }]}
              onClose={() => { onClose(); setOpen(false); }}
              onSave={vi.fn(async () => undefined)}
            />
          ) : null}
        </>
      );
    }
    renderWithProviders(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Add radio trigger' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Add Station' });
    const nameInput = screen.getByPlaceholderText('Station name…');
    await waitFor(() => expect(nameInput).toHaveFocus());
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    screen.getByRole('button', { name: 'Close' }).focus();
    await user.tab({ shift: true });
    expect(screen.getByPlaceholderText('Homepage URL (optional)')).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('exposes the cover picker as a keyboard-accessible button', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RadioEditModal
        station={null}
        sources={[{ serverId: 'home', label: 'Home' }]}
        onClose={vi.fn()}
        onSave={vi.fn(async () => undefined)}
      />,
    );

    const changeCover = screen.getByRole('button', { name: 'Change cover' });
    const coverInput = changeCover.closest('.playlist-edit-cover-wrap')?.querySelector('input[type="file"]');
    if (!(coverInput instanceof HTMLInputElement)) throw new Error('Cover input not found');
    const inputClick = vi.spyOn(coverInput, 'click');
    await waitFor(() => expect(screen.getByPlaceholderText('Station name…')).toHaveFocus());
    changeCover.focus();
    await user.keyboard('{Enter}');

    expect(inputClick).toHaveBeenCalledOnce();
    expect(changeCover.closest('.playlist-edit-cover-wrap')).not.toHaveAttribute('role');
    expect(changeCover.closest('.playlist-edit-cover-wrap')).not.toHaveAttribute('tabindex');
  });

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
