import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Orbit as OrbitIcon, Plus, LogIn, HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '@/features/orbit/store/orbitStore';
import { useAuthStore } from '@/store/authStore';
import { useHelpModalStore } from '@/features/orbit/store/helpModalStore';
import OrbitStartModal from '@/features/orbit/components/OrbitStartModal';
import OrbitJoinModal from '@/features/orbit/components/OrbitJoinModal';
import OrbitWordmark from '@/features/orbit/components/OrbitWordmark';

/**
 * Topbar trigger — opens a small launch popover offering three choices:
 * create a new session, join an existing one via invite link, or open the
 * Orbit help section. Hidden while a session is already active so we
 * don't offer entry points while the user's session bar is already live.
 */
export default function OrbitStartTrigger() {
  const { t } = useTranslation();
  const role = useOrbitStore(s => s.role);
  const visible = useAuthStore(s => s.showOrbitTrigger);
  const hostBlocked = useAuthStore(s => s.musicLibraryServerIds.length > 1);

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [joinOpen, setJoinOpen]   = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const firstEnabledItemRef = useRef<HTMLButtonElement>(null);

  // Close popover on outside click / Escape.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      setPopoverOpen(false);
    };
    queueMicrotask(() => firstEnabledItemRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setPopoverOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popoverOpen]);

  if (role !== null) return null;
  if (!visible) return null;

  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  const anchor = btnRef.current?.getBoundingClientRect();
  const popoverStyle: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        top:  anchor.bottom + 8,
        left: anchor.left,
        zIndex: 9999,
      }
    : { display: 'none' };

  const pickCreate = () => {
    if (hostBlocked) return;
    setPopoverOpen(false);
    setStartOpen(true);
  };
  const pickJoin   = () => { setPopoverOpen(false); setJoinOpen(true); };
  const pickHelp   = () => { setPopoverOpen(false); useHelpModalStore.getState().open(); };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-surface orbit-start-trigger"
        onClick={() => setPopoverOpen(v => !v)}
        data-tooltip={t('orbit.triggerTooltip')}
        data-tooltip-pos="bottom"
        aria-haspopup="menu"
        aria-expanded={popoverOpen || undefined}
        aria-label={t('orbit.triggerLabel')}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem' }}
      >
        <OrbitIcon size={18} className="orbit-start-trigger__spin" />
        <span className="orbit-start-trigger__label" style={{ display: 'inline-flex', alignItems: 'center', height: '1.5em' }}>
          <OrbitWordmark height={14} />
        </span>
      </button>

      {popoverOpen && createPortal(
        <div
          ref={popRef}
          className="nav-library-dropdown-panel orbit-launch-pop"
          style={popoverStyle}
          role="menu"
          aria-label={t('orbit.triggerLabel')}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
            );
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            items[(current + delta + items.length) % items.length]?.focus();
          }}
        >
          <button
            type="button"
            className="orbit-launch-pop__item"
            onClick={pickCreate}
            aria-disabled={hostBlocked || undefined}
            aria-describedby={hostBlocked ? 'orbit-create-scope-help' : undefined}
            role="menuitem"
            ref={firstEnabledItemRef}
          >
            <Plus size={14} />
            <span>{t('orbit.launchCreate')}</span>
          </button>
          {hostBlocked && (
            <p
              id="orbit-create-scope-help"
              style={{ margin: '0.25rem 0.75rem 0.5rem', maxWidth: '18rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}
            >
              {t('orbit.launchCreateMultiServerBlocked')}
            </p>
          )}
          <button
            type="button"
            className="orbit-launch-pop__item"
            onClick={pickJoin}
            role="menuitem"
          >
            <LogIn size={14} />
            <span>{t('orbit.launchJoin')}</span>
          </button>
          <button
            type="button"
            className="orbit-launch-pop__item"
            onClick={pickHelp}
            role="menuitem"
          >
            <HelpCircle size={14} />
            <span>{t('orbit.launchHelp')}</span>
          </button>
        </div>,
        document.body,
      )}

      {startOpen && <OrbitStartModal onClose={() => setStartOpen(false)} />}
      {joinOpen && <OrbitJoinModal onClose={() => setJoinOpen(false)} />}
    </>
  );
}
