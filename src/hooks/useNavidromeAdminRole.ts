import { useEffect, useState } from 'react';
import { ndLogin } from '../api/navidromeAdmin';
import { useAuthStore } from '../store/authStore';
import { isNavidromeServer } from '../utils/server/subsonicServerIdentity';

export type NavidromeAdminRole = 'idle' | 'checking' | 'admin' | 'user' | 'na' | 'error';

/**
 * Navidrome ≥ 0.62 restricts internet-radio management (create/update/delete) to
 * admins (GHSA-jw24-qqrj-633c). Block those actions only for a *confirmed*
 * standard Navidrome user; everything else — admin, non-Navidrome servers
 * (`'na'`), and transient/unknown states — stays allowed, with the server as the
 * final authority. Non-Navidrome servers never carried this restriction.
 */
export function canManageNavidromeRadio(role: NavidromeAdminRole): boolean {
  return role !== 'user';
}

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
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // Keyed on the server's and identity's primitive fields; depending on the
    // `server` / `identity` objects would re-probe the admin role on every render
    // when their identities change but their fields do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
