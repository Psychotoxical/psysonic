import { AlertTriangle, BarChart3, FileDown, RefreshCcw, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import SettingsSubSection from '../SettingsSubSection';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useAuthStore } from '../../store/authStore';
import {
  analysisClearFailedTracks,
  analysisDeleteAllForServer,
  analysisEnqueueSeedFromUrl,
  analysisGetFailedTrackCount,
  analysisListFailedTracks,
  type AnalysisFailedTrackDto,
  libraryAnalysisProgress,
  type LibraryAnalysisProgressDto,
} from '../../api/analysis';
import { libraryGetTracksBatch, type LibraryTrackDto, type TrackRefDto } from '../../api/library';
import { buildStreamUrlForServer } from '../../api/subsonicStreamUrl';
import { serverListDisplayLabel } from '../../utils/server/serverDisplayName';
import { serverIndexKeyForProfile } from '../../utils/server/serverIndexKey';
import { showToast } from '../../utils/ui/toast';
import {
  ANALYTICS_STRATEGIES,
  ADVANCED_PARALLELISM_MAX,
  ADVANCED_PARALLELISM_MIN,
  type AnalyticsStrategy,
} from '../../utils/library/analysisStrategy';

type ClearTarget = {
  serverId: string;
  label: string;
};

type FailedModalTarget = {
  serverId: string;
  label: string;
  indexKey: string;
};

type FailedTrackView = AnalysisFailedTrackDto & {
  title?: string | null;
  serverPath?: string | null;
};

export default function AnalyticsStrategySection() {
  const { t } = useTranslation();
  const servers = useAuthStore(s => s.servers);
  const {
    strategyByServer,
    advancedParallelismByServer,
    setServerStrategy,
    setServerAdvancedParallelism,
    clearServerOverrides,
    getStrategyForServer,
    getAdvancedParallelismForServer,
  } = useAnalysisStrategyStore();
  const [progressByServer, setProgressByServer] = useState<Record<string, LibraryAnalysisProgressDto | null>>({});
  const [failedCountByServer, setFailedCountByServer] = useState<Record<string, number>>({});
  const [failedTracksByServer, setFailedTracksByServer] = useState<Record<string, FailedTrackView[]>>({});
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);
  const [clearingServerId, setClearingServerId] = useState<string | null>(null);
  const [failedModalTarget, setFailedModalTarget] = useState<FailedModalTarget | null>(null);
  const [failedModalLoading, setFailedModalLoading] = useState(false);
  const [failedActionBusy, setFailedActionBusy] = useState(false);

  const activeServerIds = useMemo(
    () => new Set(servers.map(server => serverIndexKeyForProfile(server))),
    [servers],
  );
  const removedServerIds = useMemo(() => {
    const known = new Set([
      ...Object.keys(strategyByServer),
      ...Object.keys(advancedParallelismByServer),
    ]);
    return Array.from(known).filter(id => !activeServerIds.has(id));
  }, [strategyByServer, advancedParallelismByServer, activeServerIds]);

  const anyAggressive = useMemo(() => {
    return servers.some(server => getStrategyForServer(server.id) === 'advanced');
  }, [servers, getStrategyForServer]);

  useEffect(() => {
    if (servers.length === 0) return;
    let cancelled = false;
    const refresh = () => {
      void Promise.all(
        servers.map(server => {
          const key = serverIndexKeyForProfile(server);
          return Promise.all([
            libraryAnalysisProgress(server.id).catch(() => null),
            analysisGetFailedTrackCount(server.id).catch(() => 0),
          ])
            .then(([progress, failedCount]) => ({ key, progress, failedCount }))
            .catch(() => ({ key, progress: null, failedCount: 0 }));
        }),
      ).then(results => {
        if (cancelled) return;
        setProgressByServer(prev => {
          const next = { ...prev };
          results.forEach(({ key, progress }) => {
            next[key] = progress;
          });
          return next;
        });
        setFailedCountByServer(prev => {
          const next = { ...prev };
          results.forEach(({ key, failedCount }) => {
            next[key] = Number.isFinite(failedCount) ? failedCount : 0;
          });
          return next;
        });
      });
    };
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [servers]);

  const progressLabel = (progress: LibraryAnalysisProgressDto | null, failedCount: number) => {
    if (!progress || progress.totalTracks <= 0) return null;
    const blocked = Math.max(0, failedCount);
    const total = Math.max(0, progress.totalTracks - blocked);
    if (total <= 0) {
      return t('settings.analyticsStrategyProgressEmptyAfterFailed');
    }
    const done = Math.max(0, total - progress.pendingTracks);
    const percent = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    return t('settings.analyticsStrategyProgressValue', {
      percent,
      done: done.toLocaleString(),
      total: total.toLocaleString(),
    });
  };

  const strategyLabel = (s: AnalyticsStrategy) => {
    switch (s) {
      case 'lazy':
        return t('settings.analyticsStrategyLazy');
      case 'advanced':
        return t('settings.analyticsStrategyAdvanced');
    }
  };

  const handleClearAnalysis = async () => {
    if (!clearTarget) return;
    setClearingServerId(clearTarget.serverId);
    try {
      await analysisDeleteAllForServer(clearTarget.serverId);
      clearServerOverrides(clearTarget.serverId);
      showToast(t('settings.analyticsStrategyClearSuccess'), 4000, 'success');
    } catch {
      showToast(t('settings.analyticsStrategyClearError'), 5000, 'error');
    } finally {
      setClearingServerId(null);
      setClearTarget(null);
    }
  };

  const openFailedTracksModal = async (target: FailedModalTarget) => {
    setFailedModalTarget(target);
    setFailedModalLoading(true);
    try {
      const tracks = await analysisListFailedTracks(target.serverId, 2000);
      const refs: TrackRefDto[] = tracks.map(track => ({
        serverId: target.serverId,
        trackId: track.trackId,
      }));
      const dtoById = new Map<string, LibraryTrackDto>();
      if (refs.length > 0) {
        const batch = await libraryGetTracksBatch(refs).catch(() => []);
        batch.forEach(track => {
          if (!dtoById.has(track.id)) dtoById.set(track.id, track);
        });
      }
      const merged: FailedTrackView[] = tracks.map(track => {
        const dto = dtoById.get(track.trackId);
        return {
          ...track,
          title: dto?.title ?? null,
          serverPath: dto?.serverPath ?? null,
        };
      });
      setFailedTracksByServer(prev => ({ ...prev, [target.indexKey]: merged }));
      setFailedCountByServer(prev => ({ ...prev, [target.indexKey]: merged.length }));
    } catch {
      showToast(t('settings.analyticsFailedTracksLoadError'), 4500, 'error');
    } finally {
      setFailedModalLoading(false);
    }
  };

  const handleExportFailedTracks = async () => {
    if (!failedModalTarget) return;
    const tracks = failedTracksByServer[failedModalTarget.indexKey] ?? [];
    if (tracks.length === 0) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const suggestedName = `psysonic-failed-tracks-${stamp}.json`;
    const selected = await saveDialog({
      defaultPath: suggestedName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
      title: t('settings.analyticsFailedTracksExport'),
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const payload = {
        serverId: failedModalTarget.serverId,
        exportedAt: new Date().toISOString(),
        count: tracks.length,
        tracks,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
      await writeFile(selected, bytes);
      showToast(t('settings.analyticsFailedTracksExportSuccess', { count: tracks.length }), 3500, 'success');
    } catch {
      showToast(t('settings.analyticsFailedTracksExportError'), 4500, 'error');
    }
  };

  const handleRescanFailedTracks = async () => {
    if (!failedModalTarget) return;
    const tracks = failedTracksByServer[failedModalTarget.indexKey] ?? [];
    if (tracks.length === 0) return;
    setFailedActionBusy(true);
    try {
      const ids = tracks.map(t => t.trackId);
      await analysisClearFailedTracks(failedModalTarget.serverId, ids);
      await Promise.allSettled(
        ids.slice(0, 200).map(trackId =>
          analysisEnqueueSeedFromUrl(
            trackId,
            buildStreamUrlForServer(failedModalTarget.serverId, trackId),
            failedModalTarget.serverId,
            'low',
          ),
        ),
      );
      setFailedTracksByServer(prev => ({ ...prev, [failedModalTarget.indexKey]: [] }));
      setFailedCountByServer(prev => ({ ...prev, [failedModalTarget.indexKey]: 0 }));
      showToast(t('settings.analyticsFailedTracksRescanSuccess', { count: ids.length }), 4500, 'success');
      setFailedModalTarget(null);
    } catch {
      showToast(t('settings.analyticsFailedTracksRescanError'), 5000, 'error');
    } finally {
      setFailedActionBusy(false);
    }
  };

  return (
    <SettingsSubSection
      title={t('settings.analyticsStrategyTitle')}
      icon={<BarChart3 size={16} />}
    >
      <div className="settings-card">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('settings.analyticsStrategyDesc')}
        </p>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('settings.analyticsStrategyServerLabel')}
                </th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('settings.analyticsStrategyLabel')}
                </th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('settings.analyticsStrategyParallelismLabel')}
                </th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('settings.analyticsStrategyProgressLabel')}
                </th>
                <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {t('settings.analyticsStrategyActionsLabel')}
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map(server => {
                const strategy = getStrategyForServer(server.id);
                const advancedParallelism = getAdvancedParallelismForServer(server.id);
                const key = serverIndexKeyForProfile(server);
                const progress = progressByServer[key] ?? null;
                const failedCount = failedCountByServer[key] ?? 0;
                const label = serverListDisplayLabel(server, servers);
                return (
                  <tr key={server.id} style={{ borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.06))' }}>
                    <td style={{ padding: '10px', fontSize: 13, color: 'var(--text-primary)' }}>
                      {label}
                    </td>
                    <td style={{ padding: '10px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {ANALYTICS_STRATEGIES.map(s => (
                          <button
                            key={s}
                            type="button"
                            className={`btn btn-sm ${strategy === s ? 'btn-primary' : 'btn-surface'}`}
                            onClick={() => setServerStrategy(server.id, s)}
                          >
                            {strategyLabel(s)}
                          </button>
                        ))}
                      </div>
                    </td>
                    <td style={{ padding: '10px', minWidth: 160 }}>
                      {strategy === 'advanced' ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <input
                            type="range"
                            min={ADVANCED_PARALLELISM_MIN}
                            max={ADVANCED_PARALLELISM_MAX}
                            step={1}
                            value={advancedParallelism}
                            onChange={e => {
                              const value = parseInt(e.target.value, 10);
                              setServerAdvancedParallelism(server.id, value);
                            }}
                            style={{ flex: 1, minWidth: 80, maxWidth: 160 }}
                            aria-valuemin={ADVANCED_PARALLELISM_MIN}
                            aria-valuemax={ADVANCED_PARALLELISM_MAX}
                            aria-valuenow={advancedParallelism}
                          />
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 64 }}>
                            {t('settings.analyticsStrategyParallelismValue', { n: advancedParallelism })}
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>{progressLabel(progress, failedCount) ?? '—'}</span>
                        {failedCount > 0 && (
                          <button
                            type="button"
                            className="btn btn-sm btn-surface"
                            onClick={() => void openFailedTracksModal({ serverId: server.id, label, indexKey: key })}
                            title={t('settings.analyticsFailedTracksOpenTitle', { count: failedCount })}
                            style={{ padding: '2px 8px', minHeight: 24 }}
                          >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <TriangleAlert size={13} />
                              {failedCount}
                            </span>
                          </button>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '10px' }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-surface"
                        onClick={() => setClearTarget({ serverId: server.id, label })}
                        disabled={clearingServerId === server.id}
                      >
                        {t('settings.analyticsStrategyClearAction')}
                      </button>
                    </td>
                  </tr>
                );
              })}

              {removedServerIds.map(serverId => (
                <tr
                  key={serverId}
                  style={{ borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.06))' }}
                >
                  <td style={{ padding: '10px', fontSize: 13, color: 'var(--text-secondary)' }}>
                    <div>{serverId}</div>
                    <div style={{ fontSize: 11, color: 'var(--warning, #f59e0b)', marginTop: 2 }}>
                      {t('settings.analyticsStrategyServerRemoved')}
                    </div>
                  </td>
                  <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-muted)' }}>—</td>
                  <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-muted)' }}>—</td>
                  <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-muted)' }}>—</td>
                  <td style={{ padding: '10px' }}>
                    <button
                      type="button"
                      className="btn btn-sm btn-surface"
                      onClick={() => setClearTarget({ serverId, label: serverId })}
                      disabled={clearingServerId === serverId}
                    >
                      {t('settings.analyticsStrategyClearAction')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            marginTop: '0.85rem',
            padding: '0.65rem 0.75rem',
            borderRadius: 8,
            background: 'var(--surface-elevated, rgba(255,255,255,0.03))',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: '0.45rem', color: 'var(--text-secondary)' }}>
            {t('settings.analyticsStrategyPriorityTitle')}
          </div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
            <li>{t('settings.analyticsStrategyPriorityHigh')}</li>
            <li>{t('settings.analyticsStrategyPriorityMiddle')}</li>
            <li>{t('settings.analyticsStrategyPriorityLow')}</li>
          </ul>
        </div>

        <div
          style={{
            marginTop: '0.85rem',
            padding: '0.65rem 0.75rem',
            borderRadius: 8,
            background: 'var(--surface-elevated, rgba(255,255,255,0.03))',
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
            fontSize: 12,
            color: 'var(--text-muted)',
            lineHeight: 1.55,
          }}
        >
          <div style={{ marginBottom: '0.4rem' }}>
            <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('settings.analyticsStrategyLazy')}
            </span>
            {' '}
            {t('settings.analyticsStrategyLazyDesc')}
          </div>
          <div>
            <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('settings.analyticsStrategyAdvanced')}
            </span>
            {' '}
            {t('settings.analyticsStrategyAdvancedDesc')}
          </div>
        </div>

        {anyAggressive && (
          <div
            className="settings-hint settings-hint-info"
            role="note"
            style={{ marginTop: '0.85rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}
          >
            <AlertTriangle size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-warning, #f59e0b)' }} />
            <span style={{ fontSize: 12, lineHeight: 1.5 }}>
              {t('settings.analyticsStrategyAdvancedWarning')}
            </span>
          </div>
        )}
      </div>

      {clearTarget &&
        createPortal(
          <div
            className="modal-overlay"
            onClick={() => setClearTarget(null)}
            role="dialog"
            aria-modal="true"
            style={{ alignItems: 'center', paddingTop: 0 }}
          >
            <div
              className="modal-content"
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '420px' }}
            >
              <button
                className="modal-close"
                onClick={() => setClearTarget(null)}
                aria-label={t('settings.analyticsStrategyClearCancel')}
              >
                <X size={18} />
              </button>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>
                {t('settings.analyticsStrategyClearTitle')}
              </h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                {t('settings.analyticsStrategyClearDesc', { server: clearTarget.label })}
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  className="btn btn-primary"
                  onClick={() => setClearTarget(null)}
                  autoFocus
                  disabled={clearingServerId === clearTarget.serverId}
                >
                  {t('settings.analyticsStrategyClearCancel')}
                </button>
                <button
                  className="btn btn-surface"
                  onClick={handleClearAnalysis}
                  disabled={clearingServerId === clearTarget.serverId}
                  style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <AlertTriangle size={14} />
                    {t('settings.analyticsStrategyClearConfirm')}
                  </span>
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {failedModalTarget &&
        createPortal(
          <div
            className="modal-overlay"
            onClick={() => !failedActionBusy && setFailedModalTarget(null)}
            role="dialog"
            aria-modal="true"
            style={{ alignItems: 'center', paddingTop: 0 }}
          >
            <div
              className="modal-content"
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '680px', width: 'min(680px, 92vw)' }}
            >
              <button
                className="modal-close"
                onClick={() => setFailedModalTarget(null)}
                aria-label={t('settings.analyticsFailedTracksClose')}
                disabled={failedActionBusy}
              >
                <X size={18} />
              </button>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>
                {t('settings.analyticsFailedTracksTitle', { server: failedModalTarget.label })}
              </h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
                {t('settings.analyticsFailedTracksDesc')}
              </p>

              {failedModalLoading ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {t('settings.analyticsFailedTracksLoading')}
                </div>
              ) : (failedTracksByServer[failedModalTarget.indexKey] ?? []).length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {t('settings.analyticsFailedTracksEmpty')}
                </div>
              ) : (
                <div
                  style={{
                    border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                    borderRadius: 10,
                    maxHeight: 280,
                    overflowY: 'auto',
                    marginBottom: 12,
                  }}
                >
                  {(failedTracksByServer[failedModalTarget.indexKey] ?? []).map(track => (
                    <div
                      key={`${track.trackId}:${track.md5_16kb}:${track.updatedAt}`}
                      style={{
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--border-subtle, rgba(255,255,255,0.06))',
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 10,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            wordBreak: 'break-word',
                            color: 'var(--text-primary)',
                            fontFamily: 'var(--font-ui)',
                            fontSize: 12,
                          }}
                        >
                          {track.title?.trim() || track.trackId}
                        </div>
                        <div style={{ wordBreak: 'break-all', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                          {track.serverPath?.trim() || track.trackId}
                        </div>
                      </div>
                      <span style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                        {new Date(track.updatedAt * 1000).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-surface"
                  onClick={handleExportFailedTracks}
                  disabled={failedModalLoading || failedActionBusy || (failedTracksByServer[failedModalTarget.indexKey] ?? []).length === 0}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <FileDown size={14} />
                    {t('settings.analyticsFailedTracksExport')}
                  </span>
                </button>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => setFailedModalTarget(null)}
                    disabled={failedActionBusy}
                  >
                    {t('settings.analyticsFailedTracksClose')}
                  </button>
                  <button
                    className="btn btn-surface"
                    onClick={handleRescanFailedTracks}
                    disabled={failedModalLoading || failedActionBusy || (failedTracksByServer[failedModalTarget.indexKey] ?? []).length === 0}
                    style={{ borderColor: 'var(--warning, #f59e0b)', color: 'var(--warning, #f59e0b)' }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <RefreshCcw size={14} />
                      {t('settings.analyticsFailedTracksRescan')}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </SettingsSubSection>
  );
}
