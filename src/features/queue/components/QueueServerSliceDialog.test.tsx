import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueueServerSliceDialog } from '@/features/queue/components/QueueServerSliceDialog';
import { makeServer } from '@/test/helpers/factories';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';

const slices = [
  { server: makeServer({ id: 'a', name: 'Server A' }), trackIds: ['a-1'] },
  { server: makeServer({ id: 'b', name: 'Server B' }), trackIds: ['b-1', 'b-2'] },
];

describe('QueueServerSliceDialog accessibility', () => {
  it('focuses the selected slice, wraps Tab, closes on Escape, and restores focus', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Queue share trigger</button>
          {open ? (
            <QueueServerSliceDialog
              action="share"
              slices={slices}
              selectedServerId="a"
              onSelect={vi.fn()}
              onConfirm={vi.fn()}
              onCancel={() => { onCancel(); setOpen(false); }}
            />
          ) : null}
        </>
      );
    }
    renderWithProviders(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Queue share trigger' });
    await user.click(trigger);

    const selected = screen.getByRole('radio', { name: /Server A.*1 track/i });
    await waitFor(() => expect(selected).toHaveFocus());
    screen.getByRole('button', { name: 'Copy this slice' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Queue share trigger' })).toHaveFocus());
  });

  it('uses viewport-safe structural classes on the dialog card', () => {
    renderWithProviders(
      <QueueServerSliceDialog
        action="save"
        slices={slices}
        selectedServerId="a"
        onSelect={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog')).toHaveClass('queue-server-slice-dialog');
    expect(screen.getByRole('dialog').parentElement).toHaveClass('queue-server-slice-overlay');
  });
});
