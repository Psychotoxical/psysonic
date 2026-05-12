/**
 * Route guard for the main webview. Verifies that each auth-store precondition
 * (logged-in flag, an active server id, at least one stored server) is enforced
 * independently before the children render.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { authState } = vi.hoisted(() => ({
  authState: {
    isLoggedIn: true,
    activeServerId: 'srv-1',
    servers: [{ id: 'srv-1', name: 'home' }],
  },
}));

vi.mock('../store/authStore', () => ({
  useAuthStore: () => authState,
}));

vi.mock('react-router-dom', () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="redirect" data-to={to} />,
}));

import { RequireAuth } from './RequireAuth';

afterEach(() => {
  cleanup();
  authState.isLoggedIn = true;
  authState.activeServerId = 'srv-1';
  authState.servers = [{ id: 'srv-1', name: 'home' }];
});

describe('RequireAuth', () => {
  it('renders children when fully authenticated', () => {
    const { getByTestId, queryByTestId } = render(
      <RequireAuth>
        <div data-testid="protected" />
      </RequireAuth>,
    );
    expect(getByTestId('protected')).toBeTruthy();
    expect(queryByTestId('redirect')).toBeNull();
  });

  it('redirects to /login when not logged in', () => {
    authState.isLoggedIn = false;
    const { getByTestId, queryByTestId } = render(
      <RequireAuth>
        <div data-testid="protected" />
      </RequireAuth>,
    );
    expect(queryByTestId('protected')).toBeNull();
    expect(getByTestId('redirect').getAttribute('data-to')).toBe('/login');
  });

  it('redirects to /login when no active server id is set', () => {
    authState.activeServerId = null as unknown as string;
    const { queryByTestId, getByTestId } = render(
      <RequireAuth>
        <div data-testid="protected" />
      </RequireAuth>,
    );
    expect(queryByTestId('protected')).toBeNull();
    expect(getByTestId('redirect').getAttribute('data-to')).toBe('/login');
  });

  it('redirects to /login when the server list is empty', () => {
    authState.servers = [];
    const { queryByTestId, getByTestId } = render(
      <RequireAuth>
        <div data-testid="protected" />
      </RequireAuth>,
    );
    expect(queryByTestId('protected')).toBeNull();
    expect(getByTestId('redirect').getAttribute('data-to')).toBe('/login');
  });
});
