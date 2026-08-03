import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { SettingsSegmented } from './SettingsSegmented';

function Example() {
  const [value, setValue] = useState('bars');
  return (
    <SettingsSegmented
      ariaLabel="Visualizer mode"
      options={[
        { id: 'bars', label: 'Spectrum' },
        { id: 'scope', label: 'Oscilloscope' },
        { id: 'stereo', label: 'Stereo field' },
      ]}
      value={value}
      onChange={setValue}
    />
  );
}

describe('SettingsSegmented', () => {
  it('exposes a named radio group and the selected option', () => {
    renderWithProviders(<Example />);
    expect(screen.getByRole('radiogroup', { name: 'Visualizer mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Spectrum' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Oscilloscope' })).toHaveAttribute('aria-checked', 'false');
  });

  it('uses one Tab stop and supports arrow, Home, and End navigation', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Example />);

    const spectrum = screen.getByRole('radio', { name: 'Spectrum' });
    const scope = screen.getByRole('radio', { name: 'Oscilloscope' });
    const stereo = screen.getByRole('radio', { name: 'Stereo field' });
    spectrum.focus();

    await user.keyboard('{ArrowRight}');
    expect(scope).toHaveFocus();
    expect(scope).toHaveAttribute('aria-checked', 'true');
    expect(spectrum).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{End}');
    expect(stereo).toHaveFocus();
    expect(stereo).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('{Home}');
    expect(spectrum).toHaveFocus();
    expect(spectrum).toHaveAttribute('aria-checked', 'true');
  });
});
