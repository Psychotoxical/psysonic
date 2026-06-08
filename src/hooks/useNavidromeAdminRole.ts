import { useEffect, useState } from 'react';
import { ndLogin } from '../api/navidromeAdmin';
import { useAuthStore } from '../store/authStore';
import { isNavidromeServer } from '../utils/server/subsonicServerIdentity';

export type NavidromeAdminRole = 'idle' | 'checking' | 'admin' | 'user' | 'na' | 'error';

function normalizeServerUrl(url: string): string {
  const withScheme = url.startsWith('http') ? url : `http://${url}`;
  return withScheme.replace(/\/$/, '');
}

/**
 * Probes Navidrome native login for the active server to learn whether the
 * current Subsonic credentials belong to an admin account.
 */
export function useNavidromeAdminRole(): NavidromeAdminRole {
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const server = useAuthStore(s => s.servers.find(srv => srv.id === s.activeServerId));
  const identity = useAuthStore(s =>
    activeServerId ? s.subsonicServerIdentityByServer[activeServerId] : undefined,
  );
  const [role, setRole] = useState<NavidromeAdminRole>('idle');

  useEffect(() => {
    if (!isLoggedIn || !server) {
      setRole('na');
      return;
    }
    if (!identity) {
      setRole('checking');
      return;
    }
    if (!isNavidromeServer(identity)) {
      setRole('na');
      return;
    }

    let cancelled = false;
    setRole('checking');
    const serverUrl = normalizeServerUrl(server.url);
    ndLogin(serverUrl, server.username, server.password)
      .then(res => {
        if (cancelled) return;
        setRole(res.isAdmin ? 'admin' : 'user');
      })
      .catch(() => {
        if (!cancelled) setRole('error');
      });

    return () => {
      cancelled = true;
    };
  }, [
    isLoggedIn,
    activeServerId,
    server?.id,
    server?.url,
    server?.username,
    server?.password,
    identity?.type,
    identity?.serverVersion,
  ]);

  return role;
}
