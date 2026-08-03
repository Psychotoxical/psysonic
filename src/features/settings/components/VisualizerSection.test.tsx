import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { useVisualizerStore } from '@/features/visualizer';
import { VisualizerSection } from './VisualizerSection';

beforeEach(() => {
  useVisualizerStore.setState({
    enabled: true,
    mode: 'bars',
    sensitivity: 1,
    responsiveness: 0.65,
    fps: 60,
    showPeaks: true,
    colorSource: 'album',
    expandedSurface: null,
  });
});

describe('VisualizerSection accessibility', () => {
  it('names both sliders and every segmented setting', () => {
    renderWithProviders(<VisualizerSection t={i18n.t} />);

    expect(screen.getByRole('slider', { name: 'Sensitivity' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Responsiveness' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Default mode' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Frame rate' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Colours' })).toBeInTheDocument();
  });

  it('announces the selected mode', () => {
    renderWithProviders(<VisualizerSection t={i18n.t} />);
    expect(screen.getByRole('radio', { name: 'Spectrum' })).toHaveAttribute('aria-checked', 'true');
  });
});
