import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SelectionToggleButton from '@/ui/SelectionToggleButton';

describe('SelectionToggleButton', () => {
  it('shows the select label and calls onToggle on click', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <SelectionToggleButton
        active={false}
        onToggle={onToggle}
        selectLabel="Multi-select"
        cancelLabel="Cancel selection"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Multi-select' });
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('shows the cancel label and active styling when active', () => {
    render(
      <SelectionToggleButton
        active
        onToggle={() => {}}
        selectLabel="Multi-select"
        cancelLabel="Cancel selection"
      />,
    );
    const btn = screen.getByRole('button', { name: 'Cancel selection' });
    expect(btn).toHaveClass('btn-sort-active');
  });

  it('keeps the label in a toolbar-btn-label span for compact-mode hiding', () => {
    render(
      <SelectionToggleButton
        active={false}
        onToggle={() => {}}
        selectLabel="Multi-select"
        cancelLabel="Cancel"
      />,
    );
    expect(document.querySelector('.toolbar-btn-label')?.textContent).toBe('Multi-select');
  });
});
