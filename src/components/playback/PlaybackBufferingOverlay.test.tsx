import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { PlaybackBufferingOverlay } from './PlaybackBufferingOverlay';

describe('PlaybackBufferingOverlay', () => {
  it('exposes buffering status for assistive tech', () => {
    renderWithProviders(<PlaybackBufferingOverlay />);
    expect(
      screen.getByRole('status', { name: 'Loading track from server' }),
    ).toBeInTheDocument();
  });
});
