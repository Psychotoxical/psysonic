import type React from 'react';
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import type { ConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { usePlayQueueSyncLedState } from '@/app/hooks/usePlayQueueSyncLedState';
import type { ServerProfile } from '@/store/authStoreTypes';
import { useAuthStore } from '@/store/authStore';
import { switchActiveServer } from '@/utils/server/switchActiveServer';
import { showToast } from '@/lib/dom/toast';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';

interface Props {
  status: ConnectionStatus;
  isLan: boolean;
  serverName: string;
}

export default function ConnectionIndicator({ status, isLan, serverName }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const {
    ledVariant,
    localQueueSyncPaused,
    queueHandoffReason,
    pullInFlight,
    syncRingVisible,
    pullFromActiveServer,
  } = usePlayQueueSyncLedState(status);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [menuFixed, setMenuFixed] = useState({ top: 0, right: 0 });
  const hostRef = useRef<HTMLDivElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  const multi = servers.length > 1;

  const updateMenuPosition = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuFixed({ top: r.bottom + 6, right: window.innerWidth - r.right });
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    updateMenuPosition();
    const onWin = () => updateMenuPosition();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (hostRef.current?.contains(target)) return;
      if (menuPanelRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const goServerSettings = () => {
    setMenuOpen(false);
    navigate('/settings', { state: { tab: 'servers' } });
  };

  const onMetaClick = () => {
    if (!multi) {
      goServerSettings();
      return;
    }
    setMenuOpen(o => !o);
  };

  const onSyncClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status !== 'connected') return;
    void pullFromActiveServer();
  };

  const onPickServer = async (srv: ServerProfile) => {
    if (srv.id === activeServerId) {
      setMenuOpen(false);
      return;
    }
    setSwitchingId(srv.id);
    const ok = await switchActiveServer(srv);
    setSwitchingId(null);
    setMenuOpen(false);
    if (!ok) {
      showToast(t('connection.switchFailed'), 5000, 'error');
      return;
    }
    navigate('/');
  };

  const label = isLan ? 'LAN' : t('connection.extern');
  const tooltip = pullInFlight
    ? t('connection.queuePulling')
    : ledVariant === 'queue-handoff'
      ? localQueueSyncPaused && !queueHandoffReason
        ? t('connection.queueLocalEditHint')
        : t('connection.queuePullHint', { server: serverName })
      : ledVariant === 'connected'
        ? t('connection.queueSynced')
        : multi
          ? t('connection.switchServerHint')
          : status === 'connected'
            ? t('connection.connectedTo', { server: serverName })
            : status === 'disconnected'
              ? t('connection.disconnectedFrom', { server: serverName })
              : t('connection.checking');

  return (
    <div className="connection-indicator-host" ref={hostRef}>
      <div className="connection-indicator">
        <button
          type="button"
          className={`connection-sync-btn${syncRingVisible ? ' connection-sync-btn--visible' : ''}${pullInFlight ? ' connection-sync-btn--busy' : ''}`}
          onClick={onSyncClick}
          disabled={status !== 'connected' || pullInFlight}
          data-tooltip={tooltip}
          data-tooltip-pos="bottom"
          aria-label={t('connection.queuePullAria')}
        >
          <RefreshCw size={13} className="connection-sync-icon" aria-hidden />
          <div className={`connection-led connection-led--${ledVariant}`} />
        </button>
        <div
          className="connection-meta connection-meta--clickable"
          onClick={onMetaClick}
          data-tooltip={multi ? t('connection.switchServerHint') : undefined}
          data-tooltip-pos="bottom"
          role={multi ? 'button' : undefined}
          aria-haspopup={multi ? 'menu' : undefined}
          aria-expanded={multi ? menuOpen : undefined}
        >
          <span className="connection-type">{label}</span>
          <span className="connection-server" style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: 120 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{serverName}</span>
            {multi && (
              <ChevronDown size={12} className={menuOpen ? 'connection-indicator-chevron--open' : undefined} style={{ flexShrink: 0, opacity: 0.85 }} aria-hidden />
            )}
          </span>
        </div>
      </div>
      {multi &&
        menuOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuPanelRef}
            className="nav-library-dropdown-panel connection-indicator-dropdown-panel"
            role="menu"
            aria-label={t('connection.switchServerTitle')}
            style={{
              position: 'fixed',
              top: menuFixed.top,
              right: menuFixed.right,
              minWidth: 220,
              maxWidth: 'min(320px, 85vw)',
              zIndex: 10050,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--text-muted)',
                padding: '6px 10px 4px',
              }}
            >
              {t('connection.switchServerTitle')}
            </div>
            {servers.map(srv => {
              const active = srv.id === activeServerId;
              const busy = switchingId === srv.id;
              const labelText = serverListDisplayLabel(srv, servers);
              return (
                <button
                  key={srv.id}
                  type="button"
                  role="menuitem"
                  className={`nav-library-dropdown-item${active ? ' nav-library-dropdown-item--selected' : ''}`}
                  disabled={busy}
                  onClick={() => onPickServer(srv)}
                >
                  <span className="nav-library-dropdown-item-label">{labelText}</span>
                  {switchingId === srv.id ? (
                    <div className="spinner" style={{ width: 14, height: 14, flexShrink: 0 }} aria-hidden />
                  ) : active ? (
                    <Check size={16} className="nav-library-dropdown-check" aria-hidden />
                  ) : (
                    <span className="nav-library-dropdown-check-spacer" aria-hidden />
                  )}
                </button>
              );
            })}
            <div
              style={{
                borderTop: '1px solid color-mix(in srgb, var(--text-muted) 15%, transparent)',
                marginTop: 2,
                paddingTop: 2,
              }}
            />
            <button type="button" className="nav-library-dropdown-item" onClick={goServerSettings}>
              <span className="nav-library-dropdown-item-label">{t('connection.manageServers')}</span>
              <span className="nav-library-dropdown-check-spacer" aria-hidden />
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
