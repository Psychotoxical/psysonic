/**
 * Keyboard / ARIA contract for the shared CustomSelect (PR 1334 review):
 * the listbox must be fully operable without a pointer — arrow navigation
 * with a visible highlight, Enter/Space selection, and aria-activedescendant
 * pointing at the highlighted option.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CustomSelect from '@/ui/CustomSelect';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
];

function renderSelect(onChange = vi.fn(), value = 'a') {
  render(
    <>
      <CustomSelect value={value} options={OPTIONS} onChange={onChange} ariaLabel="pick" />
      <button type="button">After</button>
    </>,
  );
  return {
    trigger: screen.getByRole('combobox', { name: 'pick' }),
    after: screen.getByRole('button', { name: 'After' }),
    onChange,
  };
}

describe('CustomSelect keyboard operation', () => {
  it('links the combobox to its listbox and active option', async () => {
    const user = userEvent.setup();
    const { trigger } = renderSelect();
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const listbox = screen.getByRole('listbox');
    expect(trigger).toHaveAttribute('aria-controls', listbox.id);
    expect(listbox).toHaveAttribute('aria-labelledby', trigger.id);
    const active = trigger.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toBe('Alpha');
    expect(document.getElementById(active!)).toHaveAttribute('aria-selected', 'true');
  });

  it('moves the active selection with arrows while exposing disabled options', async () => {
    const user = userEvent.setup();
    const { trigger } = renderSelect();
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const active = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toBe('Gamma');
    expect(document.getElementById(active!)?.className).toContain('active');
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('option', { name: 'Beta' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter selects the highlighted option and closes the list', async () => {
    const user = userEvent.setup();
    const { trigger, onChange } = renderSelect();
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('Home and End jump to the first and last enabled options', async () => {
    const user = userEvent.setup();
    const { trigger } = renderSelect(vi.fn(), 'c');
    trigger.focus();
    await user.keyboard('{ArrowDown}{Home}');
    let active = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toBe('Alpha');
    await user.keyboard('{End}');
    active = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toBe('Gamma');
  });

  it('Tab commits the active option, closes, and moves focus onward', async () => {
    const user = userEvent.setup();
    const { trigger, after, onChange } = renderSelect();
    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.tab();

    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(after).toHaveFocus();
  });
});
