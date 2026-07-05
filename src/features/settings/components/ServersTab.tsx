import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { AlertTriangle, CheckCircle2, Info, Lock, LogOut, Pencil, Plus, Power, Server, Sparkles, Wifi, WifiOff } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { formatServerSoftware, isNavidromeAudiomuseSoftwareEligible, type InstantMixProbeResult, type SubsonicServerIdentity } from '@/lib/server/subsonicServerIdentity';
import { buildCapabilityContext } from '@/lib/serverCapabilities/context';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { libraryDeleteServerData, librarySyncClearSession } from '@/lib/api/library';
import { bootstrapIndexedServer } from '@/lib/library/librarySession';
import { useLibraryIndexSync } from '@/lib/library/hooks/useLibraryIndexSync';
import ServerLibraryIndexControls from '@/features/settings/components/ServerLibraryIndexControls';
import type { ServerProfile } from '@/store/authStoreTypes';
import { pingWithCredentialsForProfile, scheduleInstantMixProbeForServer } from '@/lib/api/subsonic';
import {
  clearServerHttpContext,
  syncServerHttpContextForProfile,
} from '@/lib/server/syncServerHttpContext';
import { type ServerMagicPayload } from '@/lib/server/serverMagicString';
import { ensureConnectUrlResolved, invalidateReachableEndpointCache } from '@/lib/server/serverEndpoint';
import {
  verifySameServerEndpoints,
  type VerifySameServerResult,
} from '@/lib/server/serverFingerprint';
import {
  indexKeyRemapForUrlChange,
  runIndexKeyRemigration,
} from '@/lib/server/serverUrlRemigration';
import { useConfirmModalStore } from '@/store/confirmModalStore';
import { showToast } from '@/lib/dom/toast';
import { FEATURE_AUDIOMUSE_SIMILAR_TRACKS } from '@/lib/serverCapabilities/catalog';
import { isFeatureActiveForServer, resolveFeatureForServer } from '@/lib/serverCapabilities/storeView';
import type { ResolvedCapability } from '@/lib/serverCapabilities/types';
import { serverIdentityLabel, serverListDisplayLabel, serverSettingsEntryTitle } from '@/lib/server/serverDisplayName';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { switchActiveServer } from '@/utils/server/switchActiveServer';
import { AddServerForm } from '@/features/settings/components/AddServerForm';
import { ServerCapabilityHeaderBadge } from '@/features/settings/components/ServerCapabilityHeaderBadge';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { applyListReorderById, type ListReorderDropTarget } from '@/lib/util/listReorder';
import { ReorderGripHandle } from '@/features/settings/components/ReorderGripHandle';
import { tooltipAttrs } from '@/ui/tooltipAttrs';

const AUDIOMUSE_NV_PLUGIN_URL = 'https://github.com/NeptuneHub/AudioMuse-AI-NV-plugin';

/** Row visibility: same as main — hide only when manual strategy proves the feature absent. */
function showAudiomuseRow(resolved: ResolvedCapability | null): boolean {
  if (!resolved || resolved.strategyId === null || resolved.status === 'ineligible') return false;
  return !(resolved.activation === 'manual' && resolved.status === 'absent');
}

/** Legacy Navidrome (< 0.62): manual toggle row below the card (not the auto header badge). */
function showLegacyAudiomuseToggleRow(
  identity: SubsonicServerIdentity | undefined,
  instantMixProbe: InstantMixProbeResult | undefined,
  resolved: ResolvedCapability | null,
): boolean {
  const ctx = buildCapabilityContext(identity);
  if (ctx.isNavidrome && ctx.semverGte([0, 62, 0])) return false;
  if (showAudiomuseRow(resolved)) return true;
  return isNavidromeAudiomuseSoftwareEligible(identity) && instantMixProbe !== 'empty';
}

export function ServersTab({
  initialInvite,
}: {
  initialInvite: ServerMagicPayload | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuthStore();
  const librarySync = useLibraryIndexSync();

  const [connStatus, setConnStatus] = useState<Record<string, 'idle' | 'testing' | 'ok' | 'error'>>({});
  const [showAddForm, setShowAddForm] = useState<boolean>(initialInvite != null);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [pastedServerInvite, setPastedServerInvite] = useState<ServerMagicPayload | null>(initialInvite);
  const serversRef = useRef(auth.servers);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  serversRef.current = auth.servers;
  const addServerInviteAnchorRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!showAddForm || !pastedServerInvite) return;
    addServerInviteAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [showAddForm, pastedServerInvite]);

  // Pick up later invites that arrive via the parent route handler while
  // ServersTab is already mounted (initial mount is handled via useState).
  useEffect(() => {
    if (initialInvite) {
      // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPastedServerInvite(initialInvite);
      setShowAddForm(true);
    }
  }, [initialInvite]);

  const applyServerReorder = useCallback((draggedId: string, target: ListReorderDropTarget) => {
    const next = applyListReorderById(serversRef.current, draggedId, target);
    if (next) auth.setServers(next);
  }, [auth]);

  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({
    type: 'server_reorder',
    apply: applyServerReorder,
  });

  const testConnection = async (server: ServerProfile) => {
    setConnStatus(s => ({ ...s, [server.id]: 'testing' }));
    try {
      // Dual-address: probe through the connect layer so the test reflects
      // whichever endpoint the app would actually use right now (LAN at home,
      // public elsewhere). probe.baseUrl also feeds the AudioMuse probe so
      // that one hits the same endpoint.
      const probe = await ensureConnectUrlResolved(server);
      if (probe.ok) {
        const identity = {
          type: probe.ping.type,
          serverVersion: probe.ping.serverVersion,
          openSubsonic: probe.ping.openSubsonic,
        };
        auth.setSubsonicServerIdentity(server.id, identity);
        scheduleInstantMixProbeForServer(server.id, probe.baseUrl, server.username, server.password, identity, true);
      }
      setConnStatus(s => ({ ...s, [server.id]: probe.ok ? 'ok' : 'error' }));
    } catch {
      setConnStatus(s => ({ ...s, [server.id]: 'error' }));
    }
  };

  const switchToServer = async (server: ServerProfile) => {
    setConnStatus(s => ({ ...s, [server.id]: 'testing' }));
    const ok = await switchActiveServer(server);
    if (ok) {
      setConnStatus(s => ({ ...s, [server.id]: 'ok' }));
      // Auf der Servers-Seite bleiben, damit der User seinen Switch hier
      // sofort visuell bestaetigt sieht (gruener Check, aktiv-Badge).
    } else {
      setConnStatus(s => ({ ...s, [server.id]: 'error' }));
    }
  };

  const deleteServer = async (server: ServerProfile) => {
    if (!confirm(t('settings.confirmDeleteServer', { name: serverListDisplayLabel(server, auth.servers) }))) {
      return;
    }
    // §5.6: when a local library index exists for this server, let the
    // user keep the cached rows (offline use) or delete them. OK =
    // delete the cache, Cancel = keep it.
    const hadIndex = useLibraryIndexStore.getState().isIndexEnabled(server.id);
    const purgeLibrary = hadIndex && confirm(t('settings.confirmDeleteServerLibrary'));

    auth.removeServer(server.id);
    try {
      await clearServerHttpContext(server);
      await librarySyncClearSession(server.id);
      if (purgeLibrary) {
        await libraryDeleteServerData(server.id);
      }
    } catch {
      /* best-effort — server already removed from the store */
    }
  };

  const closeAddServerForm = () => {
    setShowAddForm(false);
    setPastedServerInvite(null);
  };

  /**
   * Surface a dual-address verify failure as a toast (mismatch /
   * insufficient / unreachable). Returns true when the result is `ok` and
   * the caller should proceed; false when the user must fix something
   * before save.
   */
  const announceVerifyResult = (result: VerifySameServerResult): boolean => {
    if (result.ok) return true;
    if (result.reason === 'unreachable') {
      showToast(
        t('settings.dualAddressUnreachable', { host: result.unreachableHost ?? '' }),
        6000,
        'error',
      );
    } else if (result.reason === 'mismatch') {
      showToast(t('settings.dualAddressMismatch'), 6000, 'error');
    } else {
      showToast(t('settings.dualAddressInsufficient'), 6000, 'error');
    }
    return false;
  };

  const handleAddServer = async (data: Omit<ServerProfile, 'id'>) => {
    setShowAddForm(false);
    setPastedServerInvite(null);
    const tempId = '_new';
    setConnStatus(s => ({ ...s, [tempId]: 'testing' }));
    try {
      // Dual-address: confirm both addresses point at the same server
      // before persisting anything. Single-address adds skip verify and go
      // straight to the legacy ping (which is also the connect-test).
      if (data.alternateUrl) {
        const verify = await verifySameServerEndpoints(
          {
            url: data.url,
            alternateUrl: data.alternateUrl,
            customHeaders: data.customHeaders,
            customHeadersApplyTo: data.customHeadersApplyTo,
          },
          data.username,
          data.password,
        );
        if (!announceVerifyResult(verify)) {
          setConnStatus(s => ({ ...s, [tempId]: 'error' }));
          return;
        }
      }
      const ping = await pingWithCredentialsForProfile(data, data.url);
      if (ping.ok) {
        const id = auth.addServer(data);
        const identity = {
          type: ping.type,
          serverVersion: ping.serverVersion,
          openSubsonic: ping.openSubsonic,
        };
        auth.setSubsonicServerIdentity(id, identity);
        scheduleInstantMixProbeForServer(id, data.url, data.username, data.password, identity, true);
        setConnStatus(s => ({ ...s, [id]: 'ok' }));
        const added = useAuthStore.getState().servers.find(s => s.id === id);
        if (added) {
          void syncServerHttpContextForProfile(added);
          void bootstrapIndexedServer(added);
        }
      } else {
        setConnStatus(s => ({ ...s, [tempId]: 'error' }));
      }
    } catch {
      setConnStatus(s => ({ ...s, [tempId]: 'error' }));
    }
  };

  // Edit normally saves unconditionally — ping result becomes a post-save
  // status indicator (analog zum existing Test-Button) rather than blocking
  // the save. Lets users update a profile even when the server is currently
  // unreachable.
  //
  // **Dual-address exception:** when the edit introduces or changes the
  // second address (or changes the primary url while a second address is
  // already saved), verify both addresses are the same server *before*
  // persisting. A mismatch here would silently bind library / cover / queue
  // data to two unrelated boxes — the spec blocks save in v1.
  const handleEditServer = async (id: string, data: Omit<ServerProfile, 'id'>) => {
    const previous = auth.servers.find(s => s.id === id);

    // URL-change remigration — runs BEFORE everything else when the edit
    // changes the derived index key. User confirms first; on failure the
    // edit is aborted with a stage-specific toast. Spec §8.
    const remap = previous ? indexKeyRemapForUrlChange(previous, data) : null;
    if (remap) {
      const confirmed = await useConfirmModalStore.getState().request({
        title: t('settings.urlRemigrationTitle'),
        message: t('settings.urlRemigrationMessage', {
          oldKey: remap.oldKey,
          newKey: remap.newKey,
        }),
        confirmLabel: t('settings.urlRemigrationConfirm'),
        cancelLabel: t('common.cancel'),
        danger: true,
      });
      if (!confirmed) return;
      setConnStatus(s => ({ ...s, [id]: 'testing' }));
      const result = await runIndexKeyRemigration(remap);
      if (!result.ok) {
        const failureKey =
          result.failure.stage === 'inspect'
            ? 'settings.urlRemigrationFailureInspect'
            : result.failure.stage === 'run'
            ? 'settings.urlRemigrationFailureRun'
            : 'settings.urlRemigrationFailureCoverRename';
        showToast(t(failureKey), 8000, 'error');
        setConnStatus(s => ({ ...s, [id]: 'error' }));
        return;
      }
    }

    const dualAddressChanged =
      data.alternateUrl != null &&
      data.alternateUrl !== '' &&
      (data.alternateUrl !== previous?.alternateUrl ||
        data.url !== previous?.url ||
        data.username !== previous?.username ||
        data.password !== previous?.password);

    if (dualAddressChanged) {
      setConnStatus(s => ({ ...s, [id]: 'testing' }));
      const verify = await verifySameServerEndpoints(
        {
          url: data.url,
          alternateUrl: data.alternateUrl,
          customHeaders: data.customHeaders,
          customHeadersApplyTo: data.customHeadersApplyTo,
        },
        data.username,
        data.password,
      );
      if (!announceVerifyResult(verify)) {
        setConnStatus(s => ({ ...s, [id]: 'error' }));
        return;
      }
    }

    setEditingServerId(null);
    auth.updateServer(id, data);
    const updated = useAuthStore.getState().servers.find(s => s.id === id);
    if (updated) void syncServerHttpContextForProfile(updated);
    // Profile edited → any cached sticky connect URL for this id may now be
    invalidateReachableEndpointCache(id);
    setConnStatus(s => ({ ...s, [id]: 'testing' }));
    try {
      const ping = await pingWithCredentialsForProfile(data, data.url);
      if (ping.ok) {
        const identity = {
          type: ping.type,
          serverVersion: ping.serverVersion,
          openSubsonic: ping.openSubsonic,
        };
        auth.setSubsonicServerIdentity(id, identity);
        scheduleInstantMixProbeForServer(id, data.url, data.username, data.password, identity, true);
      }
      setConnStatus(s => ({ ...s, [id]: ping.ok ? 'ok' : 'error' }));
    } catch {
      setConnStatus(s => ({ ...s, [id]: 'error' }));
    }
  };

  const handleLogout = () => {
    auth.logout();
    navigate('/login');
  };

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-header">
          <Server size={18} />
          <h2>{t('settings.servers')}</h2>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
          {t('settings.serverCompatible')}
        </div>

        {auth.servers.length === 0 && !showAddForm ? (
          <div className="settings-card" style={{ color: 'var(--text-muted)', fontSize: 14 }}>
            {t('settings.noServers')}
          </div>
        ) : (
          <div
            ref={setContainer}
            onMouseMove={onMouseMove}
            style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
          >
            {auth.servers.map((srv) => {
              if (editingServerId === srv.id) {
                return (
                  <AddServerForm
                    key={srv.id}
                    editingServer={srv}
                    onSave={(data) => handleEditServer(srv.id, data)}
                    onCancel={() => setEditingServerId(null)}
                    onDelete={async () => {
                      await deleteServer(srv);
                      setEditingServerId(null);
                    }}
                  />
                );
              }
              const isActive = srv.id === auth.activeServerId;
              const status = connStatus[srv.id];
              const dropEdgeKind = isDragging ? dropEdge(srv.id) : null;
              const isBefore = dropEdgeKind === 'before';
              const isAfter  = dropEdgeKind === 'after';
              const serverSoftware = formatServerSoftware(auth.subsonicServerIdentityByServer[srv.id]);
              const serverIdentity = auth.subsonicServerIdentityByServer[srv.id];
              const resolvedAudiomuse = resolveFeatureForServer(srv.id, FEATURE_AUDIOMUSE_SIMILAR_TRACKS);
              const versionTooltip = serverSoftware ?? t('settings.serverVersionUnknown');
              const audiomuseActive = isFeatureActiveForServer(srv.id, FEATURE_AUDIOMUSE_SIMILAR_TRACKS);
              const showLegacyAudiomuseToggle = showLegacyAudiomuseToggleRow(
                serverIdentity,
                auth.instantMixProbeByServer[srv.id],
                resolvedAudiomuse,
              );
              return (
                <div
                  key={srv.id}
                  data-reorder-id={srv.id}
                  className="settings-card"
                  style={{
                    border: isActive ? '1px solid var(--accent)' : undefined,
                    background: isActive ? 'color-mix(in srgb, var(--accent) 10%, var(--bg-card))' : undefined,
                    // Drop-target indicator via inset shadow rather than
                    // borderTop/borderBottom: mixing the `border` shorthand with
                    // border-side longhands in one inline style object makes React
                    // clear the unset sides, which drops the top/bottom border on
                    // the active card (only left/right remain).
                    boxShadow: isBefore
                      ? 'inset 0 2px 0 0 var(--accent)'
                      : isAfter
                      ? 'inset 0 -2px 0 0 var(--accent)'
                      : undefined,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'stretch', gap: '0.75rem' }}>
                    <ReorderGripHandle id={srv.id} type="server_reorder" label={serverListDisplayLabel(srv, auth.servers)} />
                    <div style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '2px', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>{serverSettingsEntryTitle(srv)}</span>
                        <ServerCapabilityHeaderBadge
                          serverId={srv.id}
                          feature={FEATURE_AUDIOMUSE_SIMILAR_TRACKS}
                        />
                        {resolvedAudiomuse?.activation === 'auto' && audiomuseActive && auth.audiomuseNavidromeIssueByServer[srv.id] && (
                          <AlertTriangle
                            size={16}
                            style={{ color: 'var(--warning, #f59e0b)', flexShrink: 0 }}
                            data-tooltip={t('settings.audiomuseIssueHint')}
                            aria-label={t('settings.audiomuseIssueHint')}
                          />
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
                        {srv.url.startsWith('https://') && (
                          <Lock size={10} style={{ color: 'var(--positive)', flexShrink: 0 }} aria-hidden />
                        )}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {serverIdentityLabel(srv)}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost settings-server-version-info-btn"
                          {...tooltipAttrs(versionTooltip, { click: true })}
                        >
                          <Info size={12} aria-hidden />
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexShrink: 0, alignItems: 'center', marginLeft: 'auto' }}>
                      {status === 'ok' && <CheckCircle2 size={16} style={{ color: 'var(--positive)' }} />}
                      {status === 'error' && <WifiOff size={16} style={{ color: 'var(--danger)' }} />}
                      {status === 'testing' && <div className="spinner" style={{ width: 16, height: 16 }} />}
                      <button
                        className="btn btn-ghost"
                        style={{ padding: '4px 8px' }}
                        onClick={() => {
                          setShowAddForm(false);
                          setPastedServerInvite(null);
                          setEditingServerId(srv.id);
                        }}
                        data-tooltip={t('settings.editServer')}
                        id={`settings-edit-server-${srv.id}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        className="btn btn-surface"
                        style={{ fontSize: 12, padding: '4px 10px' }}
                        onClick={() => testConnection(srv)}
                        disabled={status === 'testing'}
                        data-tooltip={t('settings.testBtn')}
                        aria-label={t('settings.testBtn')}
                      >
                        <Wifi size={13} />
                        <span className="server-card-btn-label">{t('settings.testBtn')}</span>
                      </button>
                      {isActive ? (
                        <span className="settings-server-inline-badge settings-server-inline-badge--positive settings-server-use-active-slot">
                          {t('settings.serverActive')}
                        </span>
                      ) : (
                        <button
                          className="btn btn-primary settings-server-use-active-slot"
                          style={{ fontSize: 12, padding: '4px 10px' }}
                          onClick={() => switchToServer(srv)}
                          disabled={status === 'testing'}
                          id={`settings-use-server-${srv.id}`}
                          data-tooltip={t('settings.useServer')}
                          aria-label={t('settings.useServer')}
                        >
                          <Power size={13} />
                          <span className="server-card-btn-label">{t('settings.useServer')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                  </div>
                  <ServerLibraryIndexControls
                    status={librarySync.statusByServer[serverIndexKeyForProfile(srv)] ?? null}
                    connection={librarySync.connectionByServer[serverIndexKeyForProfile(srv)] ?? 'unknown'}
                    progressLabel={librarySync.progressByServer[serverIndexKeyForProfile(srv)] ?? null}
                    busy={librarySync.busyServerId === serverIndexKeyForProfile(srv)}
                    actionsDisabled={librarySync.globalBusy && librarySync.busyServerId !== serverIndexKeyForProfile(srv)}
                    onFullSync={() => void librarySync.runServerAction(serverIndexKeyForProfile(srv), 'full')}
                    onDeltaSync={() => void librarySync.runServerAction(serverIndexKeyForProfile(srv), 'delta')}
                    onVerify={() => void librarySync.runServerAction(serverIndexKeyForProfile(srv), 'verify')}
                    onCancel={() => void librarySync.handleCancel()}
                  />
                  {(() => {
                    if (!showLegacyAudiomuseToggle) return null;
                    const audiomuseManualActive = !!auth.audiomuseNavidromeByServer[srv.id];
                    return (
                    <div
                      className="settings-toggle-row"
                      data-settings-search={t('settings.audiomuseTitle')}
                      style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid color-mix(in srgb, var(--text-muted) 18%, transparent)' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', minWidth: 0 }}>
                        <Sparkles size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
                        <div>
                          <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            {t('settings.audiomuseTitle')}
                            {audiomuseManualActive && auth.audiomuseNavidromeIssueByServer[srv.id] && (
                              <AlertTriangle
                                size={16}
                                style={{ color: 'var(--warning, #f59e0b)', flexShrink: 0 }}
                                data-tooltip={t('settings.audiomuseIssueHint')}
                                aria-label={t('settings.audiomuseIssueHint')}
                              />
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                            <Trans
                              i18nKey="settings.audiomuseDesc"
                              components={{
                                pluginLink: (
                                  <a
                                    href={AUDIOMUSE_NV_PLUGIN_URL}
                                    onClick={e => {
                                      e.preventDefault();
                                      void openUrl(AUDIOMUSE_NV_PLUGIN_URL);
                                    }}
                                    style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                                  />
                                ),
                              }}
                            />
                          </div>
                        </div>
                      </div>
                      <label className="toggle-switch" aria-label={t('settings.audiomuseTitle')}>
                        <input
                          type="checkbox"
                          checked={audiomuseManualActive}
                          onChange={e => auth.setAudiomuseNavidromeEnabled(srv.id, e.target.checked)}
                        />
                        <span className="toggle-track" />
                      </label>
                    </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        )}

        <div
          ref={addServerInviteAnchorRef}
          id="settings-add-server-anchor"
          style={{ scrollMarginTop: '12px' }}
        >
          {showAddForm ? (
            <AddServerForm
              initialInvite={pastedServerInvite}
              onSave={handleAddServer}
              onCancel={closeAddServerForm}
            />
          ) : (
            <button
              className="btn btn-surface"
              style={{ marginTop: '0.75rem' }}
              onClick={() => {
                setPastedServerInvite(null);
                setShowAddForm(true);
              }}
              id="settings-add-server-btn"
            >
              <Plus size={16} /> {t('settings.addServer')}
            </button>
          )}
        </div>
      </section>

      <section className="settings-section">
        <button className="btn btn-danger" onClick={handleLogout} id="settings-logout-btn">
          <LogOut size={16} /> {t('settings.logout')}
        </button>
      </section>
    </>
  );
}
