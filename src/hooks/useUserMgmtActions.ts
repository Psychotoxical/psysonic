import { useState } from 'react';
import type { TFunction } from 'i18next';
import {
  ndCreateUser,
  ndDeleteUser,
  ndSetUserLibraries,
  ndUpdateUser,
  type NdLibrary,
  type NdUser,
} from '../api/navidromeAdmin';
import { showToast } from '../utils/ui/toast';
import {
  copyTextToClipboard,
  encodeServerMagicString,
} from '../utils/server/serverMagicString';
import { shortHostFromServerUrl } from '../utils/server/serverDisplayName';
import type { UserFormState } from '../components/settings/UserForm';

interface UseUserMgmtActionsArgs {
  serverUrl: string;
  token: string;
  libraries: NdLibrary[];
  editing: NdUser | 'new' | null;
  setEditing: (next: NdUser | 'new' | null) => void;
  reload: () => Promise<void>;
  t: TFunction;
}

interface UseUserMgmtActionsResult {
  busy: boolean;
  handleSave: (form: UserFormState) => Promise<void>;
  handleSaveAndGetMagic: (form: UserFormState) => Promise<void>;
  performDelete: (u: NdUser) => Promise<void>;
}

/**
 * CRUD glue for the Navidrome admin user list. Wraps the four Tauri
 * commands (create / update / set-libraries / delete) with shared
 * validation, toast surfacing, and a busy flag the parent uses to
 * disable controls.
 *
 * `handleSaveAndGetMagic` is only meaningful in the create flow for
 * non-admin users — it creates the account, attaches the chosen
 * libraries, then copies a server-magic-string to the clipboard for
 * pasting into a fresh client install.
 */
export function useUserMgmtActions({
  serverUrl,
  token,
  libraries,
  editing,
  setEditing,
  reload,
  t,
}: UseUserMgmtActionsArgs): UseUserMgmtActionsResult {
  const [busy, setBusy] = useState(false);

  const handleSave = async (form: UserFormState) => {
    const userName = form.userName.trim();
    const name = form.name.trim();
    const email = form.email.trim();
    if (editing === 'new') {
      if (!userName || !name || !form.password.trim()) {
        showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
        return;
      }
    } else if (editing) {
      if (!userName || !name) {
        showToast(t('settings.userMgmtValidationMissingIdentity'), 4000, 'error');
        return;
      }
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    if (!token) return;
    setBusy(true);
    try {
      let targetId: string;
      if (editing === 'new') {
        const created = await ndCreateUser(serverUrl, token, {
          userName, name, email, password: form.password, isAdmin: form.isAdmin,
        });
        targetId = created.id;
        showToast(t('settings.userMgmtCreated'), 3000, 'info');
      } else if (editing) {
        await ndUpdateUser(serverUrl, token, editing.id, {
          userName, name, email, password: form.password, isAdmin: form.isAdmin,
        });
        targetId = editing.id;
        showToast(t('settings.userMgmtUpdated'), 3000, 'info');
      } else {
        return;
      }
      if (!form.isAdmin && form.libraryIds.length > 0) {
        try {
          await ndSetUserLibraries(serverUrl, token, targetId, form.libraryIds);
        } catch (e) {
          const msg = (e instanceof Error && e.message) ? e.message : String(e);
          showToast(`${t('settings.userMgmtLibrariesUpdateError')}: ${msg}`, 5000, 'error');
        }
      }
      setEditing(null);
      await reload();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      const fallback = editing === 'new'
        ? t('settings.userMgmtCreateError')
        : t('settings.userMgmtUpdateError');
      showToast(msg ?? fallback, 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAndGetMagic = async (form: UserFormState) => {
    if (editing !== 'new' || form.isAdmin) return;
    const userName = form.userName.trim();
    const name = form.name.trim();
    const email = form.email.trim();
    if (!userName || !name || !form.password.trim()) {
      showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
      return;
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    if (!token) return;
    setBusy(true);
    try {
      const created = await ndCreateUser(serverUrl, token, {
        userName, name, email, password: form.password, isAdmin: form.isAdmin,
      });
      const targetId = created.id;
      showToast(t('settings.userMgmtCreated'), 3000, 'info');
      if (!form.isAdmin && form.libraryIds.length > 0) {
        try {
          await ndSetUserLibraries(serverUrl, token, targetId, form.libraryIds);
        } catch (e) {
          const msg = (e instanceof Error && e.message) ? e.message : String(e);
          showToast(`${t('settings.userMgmtLibrariesUpdateError')}: ${msg}`, 5000, 'error');
        }
      }
      const str = encodeServerMagicString({
        url: serverUrl.trim(),
        username: userName,
        password: form.password,
        name: shortHostFromServerUrl(serverUrl),
      });
      const ok = await copyTextToClipboard(str);
      showToast(
        ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
        ok ? 3000 : 5000,
        ok ? 'info' : 'error',
      );
      setEditing(null);
      await reload();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      showToast(msg ?? t('settings.userMgmtCreateError'), 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  const performDelete = async (u: NdUser) => {
    if (!token) return;
    setBusy(true);
    try {
      await ndDeleteUser(serverUrl, token, u.id);
      showToast(t('settings.userMgmtDeleted'), 3000, 'info');
      await reload();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : t('settings.userMgmtDeleteError'));
      showToast(msg, 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  return { busy, handleSave, handleSaveAndGetMagic, performDelete };
}
