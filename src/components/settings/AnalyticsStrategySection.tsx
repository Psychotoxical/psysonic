import { AlertTriangle, BarChart3, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import SettingsSubSection from '../SettingsSubSection';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import { useAuthStore } from '../../store/authStore';
import {
  analysisDeleteAllForServer,
  libraryAnalysisProgress,
  type LibraryAnalysisProgressDto,
} from '../../api/analysis';
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
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);
  const [clearingServerId, setClearingServerId] = useState<string | null>(null);

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
          return libraryAnalysisProgress(server.id)
            .then(progress => ({ key, progress }))
            .catch(() => ({ key, progress: null }));
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
      });
    };
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [servers]);

  const progressLabel = (progress: LibraryAnalysisProgressDto | null) => {
    if (!progress || progress.totalTracks <= 0) return null;
    const done = progress.doneTracks;
    const total = progress.totalTracks;
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
                      {progressLabel(progress) ?? '—'}
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
    </SettingsSubSection>
  );
}
