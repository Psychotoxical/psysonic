import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

    expect(getByRole('menuitem', { name: 'Create a session' })).toHaveAttribute('aria-disabled', 'true');
    expect(getByRole('menuitem', { name: 'Join a session' })).toBeEnabled();
    expect(queryByRole('dialog', { name: /Listen together/i })).not.toBeInTheDocument();
  });

  it('exposes a menu, focuses the first available action, explains disabled Create, and restores focus', async () => {
    const user = userEvent.setup();
    const first = makeServer({ id: 'a' });
    const second = makeServer({ id: 'b' });
    useAuthStore.setState({
      servers: [first, second],
      activeServerId: first.id,
      musicLibraryServerIds: [first.id, second.id],
      showOrbitTrigger: true,
    });
    renderWithProviders(<OrbitStartTrigger />);

    const trigger = screen.getByRole('button', { name: 'Orbit' });
    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Orbit' });
    const create = screen.getByRole('menuitem', { name: 'Create a session' });
    const join = screen.getByRole('menuitem', { name: 'Join a session' });
    expect(create).toHaveAttribute('aria-disabled', 'true');
    expect(create).toHaveAccessibleDescription(/choose one browse server/i);
    await waitFor(() => expect(create).toHaveFocus());

    await user.keyboard('{ArrowDown}');
    expect(join).toHaveFocus();
    expect(menu).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
