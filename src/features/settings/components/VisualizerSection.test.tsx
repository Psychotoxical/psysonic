import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { useVisualizerStore } from '@/features/visualizer';
import { VisualizerSection } from './VisualizerSection';

beforeEach(() => {
  useVisualizerStore.setState({
    enabledNowPlaying: true,
    enabledFullscreen: true,
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

  it('lets the mode segments keep their own width', () => {
    renderWithProviders(<VisualizerSection t={i18n.t} />);

    // Mode labels differ a lot in length once translated, and equal-width
    // segments clip the longest one. jsdom computes no layout, so the guard
    // sits on the opt-out class the stylesheet keys on.
    expect(screen.getByRole('radiogroup', { name: 'Default mode' }))
      .toHaveClass('settings-segmented-auto');
    // The short, uniform lists stay on the default equal-width look.
    expect(screen.getByRole('radiogroup', { name: 'Frame rate' }))
      .not.toHaveClass('settings-segmented-auto');
  });

  it('offers one switch per surface', () => {
    renderWithProviders(<VisualizerSection t={i18n.t} />);

    expect(screen.getByRole('checkbox', { name: 'Show on Now Playing' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Show in the fullscreen player' })).toBeChecked();
  });

  it('keeps the shared settings while one surface is still on', () => {
    // Mode, colours and frame rate apply to every surface, so switching off
    // one of them must not take the controls away.
    useVisualizerStore.setState({ enabledNowPlaying: false, enabledFullscreen: true });
    renderWithProviders(<VisualizerSection t={i18n.t} />);

    expect(screen.getByRole('radiogroup', { name: 'Default mode' })).toBeInTheDocument();
  });

  it('hides the shared settings once both surfaces are off', () => {
    useVisualizerStore.setState({ enabledNowPlaying: false, enabledFullscreen: false });
    renderWithProviders(<VisualizerSection t={i18n.t} />);

    expect(screen.queryByRole('radiogroup', { name: 'Default mode' })).toBeNull();
  });

  it('leaves range semantics to the native input', () => {
    renderWithProviders(<VisualizerSection t={i18n.t} />);

    // Browsers derive these from min/max/value; repeating them in ARIA is the
    // one thing no other slider in the repo does.
    const slider = screen.getByRole('slider', { name: 'Sensitivity' });
    expect(slider).not.toHaveAttribute('aria-valuenow');
    expect(slider).not.toHaveAttribute('aria-valuemin');
    expect(slider).not.toHaveAttribute('aria-valuemax');
  });
});
