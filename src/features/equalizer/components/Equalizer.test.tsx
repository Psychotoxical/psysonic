import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import Equalizer from '@/features/equalizer/components/Equalizer';
import { useEqStore } from '@/store/eqStore';

const FLAT = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function resetEq(over: Record<string, unknown> = {}): void {
  useEqStore.setState({
    gains: [...FLAT],
    enabled: true,
    preGain: 0,
    activePreset: 'Flat',
    customPresets: [],
    ...over,
  });
}

describe('Equalizer preset picker', () => {
  beforeEach(() => resetEq());
  afterEach(() => cleanup());

  it('shows the active AutoEQ profile name in the picker', () => {
    // AutoEQ sets activePreset to the headphone name — neither a built-in nor a
    // saved custom preset. It must still be visible in the picker.
    resetEq({ activePreset: 'Sennheiser HD 600', customPresets: [] });
    const { container } = renderWithProviders(<Equalizer />);

    expect(screen.getByText('Sennheiser HD 600')).toBeInTheDocument();
    // AutoEQ profiles are not deletable custom presets → no delete button.
    expect(container.querySelector('[data-tooltip="Delete preset"]')).toBeNull();
  });

  it('shows the delete button only for a saved custom preset', () => {
    resetEq({
      activePreset: 'My Mix',
      customPresets: [{ name: 'My Mix', gains: [...FLAT], builtin: false }],
    });
    const { container } = renderWithProviders(<Equalizer />);

    expect(screen.getByText('My Mix')).toBeInTheDocument();
    expect(container.querySelector('[data-tooltip="Delete preset"]')).not.toBeNull();
  });

  it('shows no delete button for a built-in preset', () => {
    resetEq({ activePreset: 'Rock' });
    const { container } = renderWithProviders(<Equalizer />);

    expect(container.querySelector('[data-tooltip="Delete preset"]')).toBeNull();
  });
});
