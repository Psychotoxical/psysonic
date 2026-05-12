import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

/**
 * Route guard for everything under `/*`. Redirects to `/login` until the user
 * has at least one configured server and is marked logged-in. Kept as its own
 * file so MainApp can wrap `<AppShell />` without pulling the rest of App.tsx
 * through a re-export.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, servers, activeServerId } = useAuthStore();
  if (!isLoggedIn || !activeServerId || servers.length === 0) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default RequireAuth;
