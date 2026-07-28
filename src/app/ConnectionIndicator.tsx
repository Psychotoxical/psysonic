import type React from 'react';
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Check, ChevronDown, RefreshCw } from 'lucide-react';
import type { ConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { usePlayQueueSyncLedState } from '@/app/hooks/usePlayQueueSyncLedState';
import type { ServerProfile } from '@/store/authStoreTypes';
import { useAuthStore } from '@/store/authStore';
import { switchActiveServer } from '@/utils/server/switchActiveServer';
import { showToast } from '@/lib/dom/toast';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import { ReorderGripHandle } from '@/features/settings/components/ReorderGripHandle';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { applyListReorderById } from '@/lib/util/listReorder';
import { deriveEffectiveLibraryBrowseServerIds } from '@/lib/library/libraryBrowseScope';
import { useUnavailableServerIds } from '@/lib/network/serverReachability';
import { ServerChoiceWarning } from '@/ui/ServerChoiceList';
import {
  describeMultiServerError,
  emitMultiServerDebug,
  summarizeMultiServerProfiles,
} from '@/lib/library/multiServerDebug';

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
  const libraryBrowseServerIds = useAuthStore(s => s.libraryBrowseServerIds);
  const setLibraryBrowseServerExclusive = useAuthStore(s => s.setLibraryBrowseServerExclusive);
  const setLibraryBrowseServerSelected = useAuthStore(s => s.setLibraryBrowseServerSelected);
  const setServers = useAuthStore(s => s.setServers);
  const unavailableServerIds = useUnavailableServerIds();
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
  const serversRef = useRef(servers);
  // React Compiler refs rule: event handlers need the latest persisted order.
  // eslint-disable-next-line react-hooks/refs
  serversRef.current = servers;

  const multi = servers.length > 1;
  const multiLibraryScope = libraryBrowseServerIds.length > 1;
  const effectiveLibraryServerIds = useMemo(() => deriveEffectiveLibraryBrowseServerIds({
    servers,
    activeServerId,
    libraryBrowseServerIds,
  }, unavailableServerIds), [activeServerId, libraryBrowseServerIds, servers, unavailableServerIds]);
  const unavailableSelection = multiLibraryScope
    && effectiveLibraryServerIds.length < libraryBrowseServerIds.length;
  const applyServerReorder = useCallback((draggedId: string, target: { id: string; before: boolean }) => {
    const next = applyListReorderById(serversRef.current, draggedId, target);
    emitMultiServerDebug('connection_server_reorder', {
      draggedId,
      target,
      previousOrder: serversRef.current.map(server => server.id),
      nextOrder: next?.map(server => server.id) ?? null,
    });
    if (next) setServers(next);
  }, [setServers]);
  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({
    type: 'server_reorder',
    apply: applyServerReorder,
  });

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
    emitMultiServerDebug('connection_indicator_snapshot', {
      status,
      isLan,
      displayedServerName: serverName,
      activeServerId,
      menuOpen,
      switchingId,
      configuredServerIds: libraryBrowseServerIds,
      effectiveServerIds: effectiveLibraryServerIds,
      unavailableServerIds: [...unavailableServerIds],
      multiProfile: multi,
      multiLibraryScope,
      unavailableSelection,
      servers: summarizeMultiServerProfiles(servers),
      queueLed: {
        ledVariant,
        localQueueSyncPaused,
        queueHandoffReason,
        pullInFlight,
        syncRingVisible,
      },
    });
  }, [
    activeServerId,
    effectiveLibraryServerIds,
    isLan,
    ledVariant,
    libraryBrowseServerIds,
    localQueueSyncPaused,
    menuOpen,
    multi,
    multiLibraryScope,
    pullInFlight,
    queueHandoffReason,
    serverName,
    servers,
    status,
    switchingId,
    syncRingVisible,
    unavailableSelection,
    unavailableServerIds,
  ]);

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
    emitMultiServerDebug('connection_indicator_click', {
      multiProfile: multi,
      menuOpen,
      activeServerId,
      configuredServerIds: libraryBrowseServerIds,
    });
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
    emitMultiServerDebug('connection_server_pick_start', {
      pickedServerId: srv.id,
      activeServerId,
      configuredServerIds: libraryBrowseServerIds,
      alreadyActive: srv.id === activeServerId,
    });
    if (srv.id === activeServerId) {
      setLibraryBrowseServerExclusive(srv.id);
      setMenuOpen(false);
      emitMultiServerDebug('connection_server_pick_done', {
        pickedServerId: srv.id,
        switched: false,
        action: 'exclusive_scope_only',
      });
      return;
    }
    setSwitchingId(srv.id);
    try {
      const ok = await switchActiveServer(srv);
      setSwitchingId(null);
      setMenuOpen(false);
      emitMultiServerDebug('connection_server_pick_done', {
        pickedServerId: srv.id,
        switched: ok,
        resultingActiveServerId: useAuthStore.getState().activeServerId,
      });
      if (!ok) {
        showToast(t('connection.switchFailed'), 5000, 'error');
        return;
      }
      setLibraryBrowseServerExclusive(srv.id);
      navigate('/');
    } catch (error) {
      emitMultiServerDebug('connection_server_pick_error', {
        pickedServerId: srv.id,
        error: describeMultiServerError(error),
      });
      throw error;
    }
  };

  const label = multiLibraryScope ? t('connection.multiServer') : (isLan ? 'LAN' : t('connection.extern'));
  const displayedServerName = multiLibraryScope ? (
    unavailableSelection ? (
      <Trans
        i18nKey="sidebar.serverAvailabilityCount"
        values={{
          total: libraryBrowseServerIds.length,
          available: effectiveLibraryServerIds.length,
        }}
        components={{
          unavailable: <del className="connection-server-count--unavailable" />,
        }}
      />
    ) : t('sidebar.serverSelectionCount', { count: libraryBrowseServerIds.length })
  ) : serverName;
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
            <span className="connection-server-count">{displayedServerName}</span>
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
            ref={element => {
              menuPanelRef.current = element;
              setContainer(element);
            }}
            className="nav-library-dropdown-panel connection-indicator-dropdown-panel"
            role="menu"
            onMouseMove={onMouseMove}
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
              const included = libraryBrowseServerIds.includes(srv.id);
              const finalIncluded = included && libraryBrowseServerIds.length === 1;
              const busy = switchingId === srv.id;
              const labelText = serverListDisplayLabel(srv, servers);
              const warning = unavailableServerIds.has(srv.id)
                ? t('connection.offlineSubtitle', { server: labelText })
                : undefined;
              const edge = isDragging ? dropEdge(srv.id) : null;
              return (
                <div
                  key={srv.id}
                  data-reorder-id={srv.id}
                  className={`nav-library-dropdown-item connection-indicator-server-row${included ? ' nav-library-dropdown-item--selected' : ''}${edge ? ` connection-indicator-server-row--drop-${edge}` : ''}`}
                >
                  <ReorderGripHandle id={srv.id} type="server_reorder" label={labelText} />
                  <button
                    type="button"
                    role="menuitem"
                    className="connection-indicator-server-main"
                    aria-label={warning ? `${labelText}. ${warning}` : undefined}
                    disabled={busy}
                    onClick={() => onPickServer(srv)}
                  >
                    <span className="connection-indicator-server-label">
                      <span className="nav-library-dropdown-item-label">{labelText}</span>
                      <ServerChoiceWarning warning={warning} />
                    </span>
                    {switchingId === srv.id ? (
                      <div className="spinner" style={{ width: 14, height: 14, flexShrink: 0 }} aria-hidden />
                    ) : (
                      <span className="nav-library-dropdown-check-spacer" aria-hidden />
                    )}
                  </button>
                  <button
                    type="button"
                    className={`nav-library-dropdown-item-toggle ${included ? 'nav-library-dropdown-item-toggle--on' : ''}`}
                    aria-label={`${included ? t('sidebar.libraryDeselect', { name: labelText }) : t('sidebar.librarySelect', { name: labelText })} · ${t('sidebar.libraryScope')}`}
                    aria-pressed={included}
                    disabled={finalIncluded}
                    onClick={event => {
                      event.stopPropagation();
                      emitMultiServerDebug('connection_scope_membership_change', {
                        serverId: srv.id,
                        selected: !included,
                        configuredServerIds: libraryBrowseServerIds,
                        finalIncluded,
                        unavailable: unavailableServerIds.has(srv.id),
                      });
                      setLibraryBrowseServerSelected(srv.id, !included);
                    }}
                  >
                    {included ? <Check size={16} strokeWidth={2.5} /> : <span className="nav-library-dropdown-item-toggle-box" aria-hidden />}
                  </button>
                </div>
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
