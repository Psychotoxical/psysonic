import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { decodeSharePayloadFromText } from '../utils/shareLink';
import { decodeServerMagicStringFromText } from '../utils/serverMagicString';
import { applySharePastePayload } from '../utils/applySharePaste';
import { showToast } from '../utils/toast';

/**
 * Global paste: library share links (`psysonic2-`) and server invites (`psysonic1-`)
 * outside text fields. Shares require login; invites open add-server (settings or login).
 */
export default function PasteClipboardHandler() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const busy = useRef(false);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const share = decodeSharePayloadFromText(text);
      if (share) {
        if (!isLoggedIn) {
          e.preventDefault();
          e.stopPropagation();
          showToast(t('sharePaste.notLoggedIn'), 4000, 'info');
          return;
        }
        if (busy.current) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        busy.current = true;
        void applySharePastePayload(share, navigate, t).finally(() => {
          busy.current = false;
        });
        return;
      }
      const invite = decodeServerMagicStringFromText(text);
      if (!invite) return;
      if (busy.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      busy.current = true;
      if (isLoggedIn) {
        navigate('/settings', { state: { tab: 'server' as const, openAddServerInvite: invite } });
      } else {
        navigate('/login', { state: { openAddServerInvite: invite } });
      }
      queueMicrotask(() => {
        busy.current = false;
      });
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, [navigate, t, isLoggedIn]);

  return null;
}
