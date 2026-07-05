import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { FsClock } from '@/features/fullscreenPlayer/components/FsClock';

describe('FsClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 21, 59, 0));
    resetAuthStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the 24-hour clock format from Settings → System', () => {
    useAuthStore.setState({ clockFormat: '24h' });
    renderWithProviders(<FsClock />);
    expect(screen.getByText('21:59')).toBeInTheDocument();
    expect(screen.queryByText(/AM|PM/i)).toBeNull();
  });

  it('uses the 12-hour clock format when selected', () => {
    useAuthStore.setState({ clockFormat: '12h' });
    renderWithProviders(<FsClock />);
    expect(screen.getByText('09:59 PM')).toBeInTheDocument();
  });
});
