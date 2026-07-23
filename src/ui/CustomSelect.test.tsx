/**
 * Keyboard / ARIA contract for the shared CustomSelect (PR 1334 review):
 * the listbox must be fully operable without a pointer — arrow navigation
 * with a visible highlight, Enter/Space selection, and aria-activedescendant
 * pointing at the highlighted option.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CustomSelect from '@/ui/CustomSelect';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
];

function renderSelect(onChange = vi.fn(), value = 'a') {
  render(
    <CustomSelect value={value} options={OPTIONS} onChange={onChange} ariaLabel="pick" />,
  );
  return { trigger: screen.getByRole('button', { name: 'pick' }), onChange };
}

describe('CustomSelect keyboard operation', () => {
  it('ArrowDown opens the listbox with the selected option highlighted', () => {
    const { trigger } = renderSelect();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeTruthy();
    const active = trigger.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toBe('Alpha');
  });

  it('arrow keys move the highlight, skipping disabled options', () => {
    const { trigger } = renderSelect();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // open on Alpha
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // skips disabled Beta
    const active = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toBe('Gamma');
    expect(document.getElementById(active!)?.className).toContain('active');
  });

  it('Enter selects the highlighted option and closes the list', () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Home and End jump to the first and last enabled options', () => {
    const { trigger } = renderSelect(vi.fn(), 'c');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' }); // open on Gamma
    fireEvent.keyDown(trigger, { key: 'Home' });
    let active = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toBe('Alpha');
    fireEvent.keyDown(trigger, { key: 'End' });
    active = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).toBe('Gamma');
  });

  it('never highlights a disabled option via keyboard', () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    for (let i = 0; i < 6; i++) fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const active = trigger.getAttribute('aria-activedescendant');
    expect(document.getElementById(active!)?.textContent).not.toBe('Beta');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalledWith('b');
  });
});
