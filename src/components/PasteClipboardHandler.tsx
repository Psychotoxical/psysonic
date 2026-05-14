import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { decodeSharePayloadFromText } from '../utils/share/shareLink';
import { decodeServerMagicStringFromText } from '../utils/server/serverMagicString';
import { applySharePastePayload } from '../utils/share/applySharePaste';
import { showToast } from '../utils/ui/toast';
import {
  parseOrbitShareLink,
  joinOrbitSession,
  findSessionPlaylistId,
  readOrbitState,
  OrbitJoinError,
} from '../utils/orbit';
import { switchActiveServer } from '../utils/server/switchActiveServer';
import { useOrbitAccountPickerStore } from '../store/orbitAccountPickerStore';
import ConfirmModal from './ConfirmModal';

const ORBIT_JOIN_ERROR_KEYS: Record<string, string> = {
  'not-found':    'orbit.joinErrNotFound',
  'ended':        'orbit.joinErrEnded',
  'full':         'orbit.joinErrFull',
  'kicked':       'orbit.joinErrKicked',
  'no-user':      'orbit.joinErrNoUser',
  'server-error': 'orbit.joinErrServerError',
};

/**
 * Global paste: library share links (`psysonic2-`) and server invites (`psysonic1-`)
 * outside text fields. Shares require login; invites open add-server (settings or login).
 */
export default function PasteClipboardHandler() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const busy = useRef(false);
  const [orbitConfirm, setOrbitConfirm] = useState<{ sid: string; host: string; name: string } | null>(null);
  const [orbitInvalid, setOrbitInvalid] = useState(false);

  // `not-found` and `ended` collapse into a single "link no longer valid"
  // dialog — from the guest's POV both mean the same thing: the invite
  // doesn't lead anywhere any more. Other reasons stay as toasts because
  // they're actionable (full → wait, kicked → talk to host, etc.).
  const handleJoinError = (reason: string | null, fallback?: string) => {
    if (reason === 'not-found' || reason === 'ended') {
      setOrbitInvalid(true);
      return;
    }
    const i18nKey = reason ? ORBIT_JOIN_ERROR_KEYS[reason] : null;
    showToast(i18nKey ? t(i18nKey) : (fallback ?? t('orbit.toastJoinFail')), 4000, 'error');
  };

  const runOrbitJoin = (sid: string) => {
    if (busy.current) return;
    busy.current = true;
    joinOrbitSession(sid)
      .then(() => showToast(t('orbit.toastJoined'), 2500, 'info'))
      .catch(err => {
        if (err instanceof OrbitJoinError) handleJoinError(err.reason, err.message);
        else                               handleJoinError(null);
      })
      .finally(() => { busy.current = false; });
  };

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

      // Orbit share link — handled before library shares.
      const orbit = parseOrbitShareLink(text.trim());
      if (orbit) {
        e.preventDefault();
        e.stopPropagation();
        if (!isLoggedIn) { showToast(t('orbit.toastLoginFirst'), 4000, 'info'); return; }
        if (busy.current) return;
        busy.current = true;

        (async () => {
          const active = useAuthStore.getState().getActiveServer();
          const activeUrl = (active?.url ?? '').replace(/\/+$/, '');
          const wantUrl   = orbit.serverBase.replace(/\/+$/, '');

          // Auto-switch to the link's target server if the user has an
          // account registered for it. No account → clear error. Multiple
          // accounts for the same URL → picker lets the user choose. The
          // switch itself tears down any lingering orbit session (see
          // switchActiveServer) so the join below starts clean.
          if (activeUrl !== wantUrl) {
            const candidates = useAuthStore.getState().servers
              .filter(s => s.url.replace(/\/+$/, '') === wantUrl);
            if (candidates.length === 0) {
              showToast(t('orbit.toastNoAccountForServer', { url: wantUrl }), 5000, 'warning');
              return;
            }
            const target = candidates.length === 1
              ? candidates[0]
              : await useOrbitAccountPickerStore.getState().request(candidates);
            if (!target) return; // cancelled
            const switched = await switchActiveServer(target);
            if (!switched) {
              showToast(t('orbit.toastSwitchFailed', { url: wantUrl }), 5000, 'error');
              return;
            }
          }

          // Preview the session state so the confirm dialog can show the
          // host and session name. Failures surface the same error toasts
          // the join would, without ever showing the confirm.
          const playlistId = await findSessionPlaylistId(orbit.sid);
          if (!playlistId) { handleJoinError('not-found'); return; }
          const state = await readOrbitState(playlistId);
          if (!state)      { handleJoinError('not-found'); return; }
          if (state.ended) { handleJoinError('ended');     return; }
          setOrbitConfirm({ sid: orbit.sid, host: state.host, name: state.name });
        })()
          .catch(() => handleJoinError(null))
          .finally(() => { busy.current = false; });
        return;
      }

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

  return (
    <>
      <ConfirmModal
        open={!!orbitConfirm}
        title={t('orbit.confirmJoinTitle')}
        message={t('orbit.confirmJoinBody', {
          host: orbitConfirm?.host ?? '',
          name: orbitConfirm?.name ?? '',
        })}
        confirmLabel={t('orbit.confirmJoinConfirm')}
        cancelLabel={t('orbit.confirmCancel')}
        onConfirm={() => {
          const sid = orbitConfirm?.sid;
          setOrbitConfirm(null);
          if (sid) runOrbitJoin(sid);
        }}
        onCancel={() => setOrbitConfirm(null)}
      />
      <ConfirmModal
        open={orbitInvalid}
        title={t('orbit.invalidLinkTitle')}
        message={t('orbit.invalidLinkBody')}
        confirmLabel={t('orbit.exitOk')}
        onConfirm={() => setOrbitInvalid(false)}
      />
    </>
  );
}
