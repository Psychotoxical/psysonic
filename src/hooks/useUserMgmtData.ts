import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import {
  ndListLibraries,
  ndListUsers,
  type NdLibrary,
  type NdUser,
} from '../api/navidromeAdmin';

interface UseUserMgmtDataResult {
  users: NdUser[];
  libraries: NdLibrary[];
  loading: boolean;
  loadError: string | null;
  load: () => Promise<void>;
}

/**
 * Fetch and keep the Navidrome admin users + libraries lists in sync.
 *
 * The two requests are **sequential, not parallel**: some nginx setups
 * with churning upstream keep-alive drop one of two parallel TLS
 * connections. Doing users first then libraries keeps us on one
 * connection at a time and pairs cleanly with the `nd_retry` backoff on
 * the Rust side.
 *
 * Tauri's `invoke` rejects with a bare `string` (our Rust commands
 * return `Err(String)`), so the error normalisation surfaces the real
 * cause (e.g. `tls handshake eof`) instead of falling back to the
 * generic i18n string.
 */
export function useUserMgmtData(serverUrl: string, token: string, t: TFunction): UseUserMgmtDataResult {
  const [users, setUsers] = useState<NdUser[]>([]);
  const [libraries, setLibraries] = useState<NdLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await ndListUsers(serverUrl, token);
      const libs = await ndListLibraries(serverUrl, token).catch(() => [] as NdLibrary[]);
      setUsers([...list].sort((a, b) => a.userName.localeCompare(b.userName)));
      setLibraries([...libs].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      const raw = typeof e === 'string'
        ? e
        : (e instanceof Error && e.message)
          ? e.message
          : '';
      const prefix = t('settings.userMgmtLoadError');
      setLoadError(raw ? `${prefix} ${raw}` : prefix);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, token, t]);

  useEffect(() => { void load(); }, [load]);

  return { users, libraries, loading, loadError, load };
}
