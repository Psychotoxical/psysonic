import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrackTransitionsBlock } from './TrackTransitionsBlock';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAuthStore, resetOrbitStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import i18n from '@/lib/i18n';

beforeEach(() => {
  resetAuthStore();
  resetOrbitStore();
});

describe('TrackTransitionsBlock pause/resume fade', () => {
  it('reveals the duration slider and persists changes when enabled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrackTransitionsBlock t={i18n.t} />);

    expect(screen.queryByRole('slider', { name: 'Fade duration' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Pause and resume fade' }));

    const slider = screen.getByRole('slider', { name: 'Fade duration' });
    expect(slider).toHaveValue('1');
    fireEvent.change(slider, { target: { value: '0.8' } });
    expect(useAuthStore.getState().pauseResumeFadeSecs).toBe(0.8);
  });
});
