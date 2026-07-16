import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import OrbitStartTrigger from '@/features/orbit/components/OrbitStartTrigger';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAllStores } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { makeServer } from '@/test/helpers/factories';

describe('OrbitStartTrigger host gate', () => {
  beforeEach(resetAllStores);

  it('keeps Join available but disables Create for a multi-server browse scope', () => {
    const first = makeServer({ id: 'a' });
    const second = makeServer({ id: 'b' });
    useAuthStore.setState({
      servers: [first, second],
      activeServerId: first.id,
      musicLibraryServerIds: [first.id, second.id],
      showOrbitTrigger: true,
    });

    const { getByRole, queryByRole } = renderWithProviders(<OrbitStartTrigger />);
    fireEvent.click(getByRole('button', { name: 'Orbit' }));

    expect(getByRole('button', { name: 'Create a session' })).toBeDisabled();
    expect(getByRole('button', { name: 'Join a session' })).toBeEnabled();
    expect(queryByRole('dialog', { name: /Listen together/i })).not.toBeInTheDocument();
  });
});
