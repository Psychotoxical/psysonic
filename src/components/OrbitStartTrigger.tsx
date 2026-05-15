import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Orbit as OrbitIcon, Plus, LogIn, HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import { useAuthStore } from '../store/authStore';
import { useHelpModalStore } from '../store/helpModalStore';
import OrbitStartModal from './OrbitStartModal';
import OrbitJoinModal from './OrbitJoinModal';
import OrbitWordmark from './OrbitWordmark';

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

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [joinOpen, setJoinOpen]   = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Close popover on outside click / Escape.
  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      setPopoverOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopoverOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popoverOpen]);

  if (role !== null) return null;
  if (!visible) return null;

  const anchor = btnRef.current?.getBoundingClientRect();
  const popoverStyle: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        top:  anchor.bottom + 8,
        left: anchor.left,
        zIndex: 9999,
      }
    : { display: 'none' };

  const pickCreate = () => { setPopoverOpen(false); setStartOpen(true); };
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
        <div ref={popRef} className="nav-library-dropdown-panel orbit-launch-pop" style={popoverStyle} role="menu">
          <button type="button" className="orbit-launch-pop__item" onClick={pickCreate}>
            <Plus size={14} />
            <span>{t('orbit.launchCreate')}</span>
          </button>
          <button type="button" className="orbit-launch-pop__item" onClick={pickJoin}>
            <LogIn size={14} />
            <span>{t('orbit.launchJoin')}</span>
          </button>
          <button
            type="button"
            className="orbit-launch-pop__item"
            onClick={pickHelp}
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
