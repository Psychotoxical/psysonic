import { Image, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsSubCard } from '@/features/settings/components/SettingsSubCard';
import { useCoverStrategyStore } from '@/store/coverStrategyStore';
import { useAuthStore } from '@/store/authStore';
import {
  coverCacheClearServer,
  coverCacheStatsServer,
  libraryCoverCatalogSize,
  libraryCoverProgress,
} from '@/lib/api/coverCache';
import { clearDiskSrcCacheForServer } from '@/cover/diskSrcCache';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { showToast } from '@/lib/dom/toast';
import { formatBytes } from '@/lib/format/formatBytes';
import { clearImageCache, getImageCacheSize } from '@/cover';
import { wakeLibraryCoverBackfill } from '@/lib/library/coverBackfillWake';
import {
  COVER_CACHE_STRATEGIES,
  type CoverCacheStrategy,
} from '@/lib/library/coverStrategy';

type ClearTarget =
  | { kind: 'image' }
  | { kind: 'disk'; serverId: string; indexKey: string; label: string };

const ROW_BORDER = { borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.06))' } as const;
const TH_STYLE = {
  textAlign: 'left' as const,
  padding: '8px 10px',
  fontSize: 12,
  color: 'var(--text-muted)',
};

const TABLE_STYLE = {
  width: '100%',
  borderCollapse: 'collapse',
  minWidth: 520,
  tableLayout: 'fixed',
} as const;

const STRATEGY_GAP_TH: CSSProperties = { ...TH_STYLE, padding: '8px 10px' };
const STRATEGY_GAP_TD: CSSProperties = { padding: '10px' };

function CoverCacheColGroup() {
  return (
    <colgroup>
      <col style={{ width: '22%' }} />
      <col style={{ width: '38%' }} />
      <col style={{ width: '22%' }} />
      <col style={{ width: '18%' }} />
    </colgroup>
  );
}

type ServerRowState = {
  bytes: number;
  entryCount: number;
  done: number;
  total: number;
  pending: number;
};

export default function CoverCacheStrategySection() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const servers = auth.servers;
  const activeServerId = auth.activeServerId;
  const { strategyByServer, setServerStrategy, getStrategyForServer } = useCoverStrategyStore();
  const [rowState, setRowState] = useState<Record<string, ServerRowState>>({});
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);
  const [clearingKey, setClearingKey] = useState<string | null>(null);
  const [imageCacheBytes, setImageCacheBytes] = useState<number | null>(null);

  const activeIndexKeys = useMemo(
    () => new Set(servers.map(server => serverIndexKeyForProfile(server))),
    [servers],
  );
  const removedServerKeys = useMemo(() => {
    const known = new Set(Object.keys(strategyByServer));
    return Array.from(known).filter(key => !activeIndexKeys.has(key));
  }, [strategyByServer, activeIndexKeys]);

  const refreshRow = useCallback(async (serverId: string, indexKey: string) => {
    const [stats, progress, catalog] = await Promise.all([
      coverCacheStatsServer(indexKey).catch(() => ({ bytes: 0, entryCount: 0 })),
      libraryCoverProgress(indexKey, serverId).catch(() => ({ done: 0, totalDistinct: 0, pending: 0 })),
      libraryCoverCatalogSize(serverId).catch(() => 0),
    ]);
    const total = Math.max(progress.totalDistinct, catalog);
    setRowState(prev => ({
      ...prev,
      [indexKey]: {
        bytes: stats.bytes,
        entryCount: stats.entryCount,
        done: progress.done,
        total,
        pending: Math.max(progress.pending, total > 0 ? total - progress.done : 0),
      },
    }));
  }, []);

  const refreshAll = useCallback(() => {
    void Promise.all(
      servers.map(server => refreshRow(server.id, serverIndexKeyForProfile(server))),
    );
  }, [servers, refreshRow]);

  // Recompute on entry only. Live updates during an active backfill arrive via the
  // `cover:library-progress` event (carries done/total/pending/bytes/entryCount), and
  // clearing the cache emits `cover:cache-cleared`. A slow 5-minute tick is just a
  // safety net for changes made outside this view (e.g. browsing-time caching); it is
  // not needed for correctness, so we avoid re-walking the cover dirs in a tight loop.
  useEffect(() => {
    void getImageCacheSize().then(setImageCacheBytes);
    refreshAll();
    const id = window.setInterval(refreshAll, 300_000);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    void (async () => {
      unsubs.push(await listen<{
        serverIndexKey?: string;
        done?: number;
        total?: number;
        pending?: number;
        bytes?: number;
        entryCount?: number;
      }>('cover:library-progress', e => {
        const key = e.payload.serverIndexKey;
        if (!key) return;
        setRowState(prev => {
          const cur = prev[key];
          if (!cur) return prev;
          const done = typeof e.payload.done === 'number' ? e.payload.done : cur.done;
          const total = typeof e.payload.total === 'number' ? e.payload.total : cur.total;
          return {
            ...prev,
            [key]: {
              ...cur,
              done,
              total,
              pending: e.payload.pending ?? Math.max(0, total - done),
              bytes: typeof e.payload.bytes === 'number' ? e.payload.bytes : cur.bytes,
              entryCount:
                typeof e.payload.entryCount === 'number' ? e.payload.entryCount : cur.entryCount,
            },
          };
        });
      }));
      unsubs.push(await listen<{ serverIndexKey?: string }>('cover:cache-cleared', e => {
        const key = e.payload.serverIndexKey;
        if (key) {
          setRowState(prev => ({
            ...prev,
            [key]: { bytes: 0, entryCount: 0, done: 0, total: prev[key]?.total ?? 0, pending: prev[key]?.total ?? 0 },
          }));
        } else {
          refreshAll();
        }
      }));
    })();
    return () => {
      for (const u of unsubs) u();
    };
  }, [refreshAll]);

  const strategyLabel = (s: CoverCacheStrategy) => {
    switch (s) {
      case 'lazy':
        return t('settings.coverCacheStrategyLazy');
      case 'aggressive':
        return t('settings.coverCacheStrategyAggressive');
    }
  };

  const progressLabel = (row: ServerRowState | undefined, strategy: CoverCacheStrategy) => {
    if (!row || strategy !== 'aggressive' || row.total <= 0) {
      return row ? t('settings.coverCacheStrategyDiskUsage', { size: formatBytes(row.bytes) }) : '—';
    }
    const percent = Math.max(0, Math.min(100, Math.round((row.done / row.total) * 100)));
    return t('settings.coverCacheStrategyProgressValue', {
      percent,
      done: row.done.toLocaleString(),
      total: row.total.toLocaleString(),
      size: formatBytes(row.bytes),
    });
  };

  const handleStrategyChange = (serverId: string, strategy: CoverCacheStrategy) => {
    setServerStrategy(serverId, strategy);
    if (serverId === activeServerId) {
      wakeLibraryCoverBackfill();
    }
  };

  const handleClearConfirm = async () => {
    if (!clearTarget) return;
    if (clearTarget.kind === 'image') {
      setClearingKey('image');
      try {
        await clearImageCache();
        setImageCacheBytes(await getImageCacheSize());
      } finally {
        setClearingKey(null);
        setClearTarget(null);
      }
      return;
    }
    setClearingKey(clearTarget.indexKey);
    try {
      await coverCacheClearServer(clearTarget.indexKey);
      clearDiskSrcCacheForServer(clearTarget.indexKey);
      await refreshRow(clearTarget.serverId, clearTarget.indexKey);
      if (clearTarget.serverId === activeServerId) {
        wakeLibraryCoverBackfill();
      }
      showToast(t('settings.coverCacheStrategyClearSuccess'), 4000, 'success');
    } catch {
      showToast(t('settings.coverCacheStrategyClearError'), 5000, 'error');
    } finally {
      setClearingKey(null);
      setClearTarget(null);
    }
  };

  return (
    <SettingsSubSection title={t('settings.coverCacheStrategyTitle')} icon={<Image size={16} />}>
      <div className="settings-card">
        <SettingsGroup>
        <SettingsSubCard>
        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE_STYLE}>
            <CoverCacheColGroup />
            <thead>
              <tr>
                <th style={{ ...TH_STYLE, paddingLeft: 0 }}>{t('settings.imageCacheScopeLabel')}</th>
                <th style={STRATEGY_GAP_TH} aria-hidden="true" />
                <th style={TH_STYLE}>{t('settings.coverCacheStrategyProgressLabel')}</th>
                <th style={TH_STYLE}>{t('settings.coverCacheStrategyActionsLabel')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: '10px', paddingLeft: 0, fontSize: 13, color: 'var(--text-primary)' }}>
                  {t('settings.imageCacheSubTitle')}
                </td>
                <td style={STRATEGY_GAP_TD} aria-hidden="true" />
                <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {imageCacheBytes !== null
                    ? t('settings.coverCacheStrategyDiskUsage', { size: formatBytes(imageCacheBytes) })
                    : '—'}
                </td>
                <td style={{ padding: '10px' }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ fontSize: 12 }}
                    onClick={() => setClearTarget({ kind: 'image' })}
                  >
                    <Trash2 size={14} /> {t('settings.cacheClearBtn')}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          style={{
            margin: '20px 0 10px',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-primary)',
          }}
        >
          {t('settings.coverDiskCacheSubTitle')}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE_STYLE}>
            <CoverCacheColGroup />
            <thead>
              <tr>
                <th style={{ ...TH_STYLE, paddingLeft: 0 }}>{t('settings.coverCacheStrategyServerLabel')}</th>
                <th style={TH_STYLE}>{t('settings.coverCacheStrategyLabel')}</th>
                <th style={TH_STYLE}>{t('settings.coverCacheStrategyProgressLabel')}</th>
                <th style={TH_STYLE}>{t('settings.coverCacheStrategyActionsLabel')}</th>
              </tr>
            </thead>
            <tbody>
              {servers.map(server => {
                const strategy = getStrategyForServer(server.id);
                const key = serverIndexKeyForProfile(server);
                const row = rowState[key];
                const label = serverListDisplayLabel(server, servers);
                return (
                  <tr key={server.id} style={ROW_BORDER}>
                    <td style={{ padding: '10px', paddingLeft: 0, fontSize: 13, color: 'var(--text-primary)' }}>{label}</td>
                    <td style={{ padding: '10px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {COVER_CACHE_STRATEGIES.map(s => (
                          <button
                            key={s}
                            type="button"
                            className={`btn btn-sm ${strategy === s ? 'btn-primary' : 'btn-surface'}`}
                            onClick={() => handleStrategyChange(server.id, s)}
                          >
                            {strategyLabel(s)}
                          </button>
                        ))}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.4 }}>
                        {strategy === 'aggressive'
                          ? t('settings.coverCacheStrategyAggressiveDesc')
                          : t('settings.coverCacheStrategyLazyDesc')}
                      </div>
                    </td>
                    <td style={{ padding: '10px', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {progressLabel(row, strategy)}
                    </td>
                    <td style={{ padding: '10px' }}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 12 }}
                        onClick={() =>
                          setClearTarget({ kind: 'disk', serverId: server.id, indexKey: key, label })}
                      >
                        <Trash2 size={14} /> {t('settings.coverCacheStrategyClearAction')}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {removedServerKeys.map(key => (
                <tr key={`removed-${key}`} style={ROW_BORDER}>
                  <td style={{ padding: '10px', paddingLeft: 0, fontSize: 13, color: 'var(--text-muted)' }}>
                    {key}
                    <span style={{ marginLeft: 6, fontSize: 11 }}>({t('settings.coverCacheStrategyServerRemoved')})</span>
                  </td>
                  <td style={STRATEGY_GAP_TD} aria-hidden="true" />
                  <td style={STRATEGY_GAP_TD} aria-hidden="true" />
                  <td style={{ padding: '10px' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ fontSize: 12 }}
                      onClick={() =>
                        setClearTarget({ kind: 'disk', serverId: key, indexKey: key, label: key })}
                    >
                      <Trash2 size={14} /> {t('settings.coverCacheStrategyClearAction')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: '0.9rem', lineHeight: 1.5 }}>
          {t('settings.coverCacheStrategyDesc')}
        </p>

        {clearTarget && (
          <div
            style={{
              marginTop: 16,
              background: 'color-mix(in srgb, var(--color-danger, #e53935) 10%, transparent)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
              fontSize: 13,
            }}
          >
            {clearTarget.kind === 'image' ? (
              <>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('settings.cacheClearBtn')}</div>
                <div style={{ marginBottom: 10, lineHeight: 1.5 }}>{t('settings.cacheClearWarning')}</div>
              </>
            ) : (
              <>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('settings.coverCacheStrategyClearTitle')}</div>
                <div style={{ marginBottom: 10, lineHeight: 1.5 }}>
                  {t('settings.coverCacheStrategyClearDesc', { server: clearTarget.label })}
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn-primary"
                style={{ background: 'var(--color-danger, #e53935)', fontSize: 13 }}
                disabled={clearingKey !== null}
                onClick={() => void handleClearConfirm()}
              >
                {clearTarget.kind === 'image'
                  ? t('settings.cacheClearConfirm')
                  : t('settings.coverCacheStrategyClearConfirm')}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 13 }}
                disabled={clearingKey !== null}
                onClick={() => setClearTarget(null)}
              >
                {clearTarget.kind === 'image'
                  ? t('settings.cacheClearCancel')
                  : t('settings.coverCacheStrategyClearCancel')}
              </button>
            </div>
          </div>
        )}
        </SettingsSubCard>
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
