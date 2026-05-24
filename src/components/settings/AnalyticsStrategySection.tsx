import { AlertTriangle, BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import SettingsSubSection from '../SettingsSubSection';
import { useAnalysisStrategyStore } from '../../store/analysisStrategyStore';
import {
  ANALYTICS_STRATEGIES,
  ADVANCED_PARALLELISM_MAX,
  ADVANCED_PARALLELISM_MIN,
  type AnalyticsStrategy,
} from '../../utils/library/analysisStrategy';

type AnalyticsStrategySectionProps = {
  serverId?: string;
  serverLabel?: string;
};

export default function AnalyticsStrategySection({
  serverId,
  serverLabel,
}: AnalyticsStrategySectionProps) {
  const { t } = useTranslation();
  const strategy = useAnalysisStrategyStore(s =>
    serverId ? s.getStrategyForServer(serverId) : s.strategy,
  );
  const advancedParallelism = useAnalysisStrategyStore(s =>
    serverId ? s.getAdvancedParallelismForServer(serverId) : s.advancedParallelism,
  );
  const setStrategy = useAnalysisStrategyStore(s => s.setStrategy);
  const setAdvancedParallelism = useAnalysisStrategyStore(s => s.setAdvancedParallelism);
  const setServerStrategy = useAnalysisStrategyStore(s => s.setServerStrategy);
  const setServerAdvancedParallelism = useAnalysisStrategyStore(s => s.setServerAdvancedParallelism);

  const strategyLabel = (s: AnalyticsStrategy) => {
    switch (s) {
      case 'lazy':
        return t('settings.analyticsStrategyLazy');
      case 'advanced':
        return t('settings.analyticsStrategyAdvanced');
    }
  };

  const strategyDesc = (s: AnalyticsStrategy) => {
    switch (s) {
      case 'lazy':
        return t('settings.analyticsStrategyLazyDesc');
      case 'advanced':
        return t('settings.analyticsStrategyAdvancedDesc');
    }
  };

  return (
    <SettingsSubSection
      title={serverLabel
        ? `${t('settings.analyticsStrategyTitle')} — ${serverLabel}`
        : t('settings.analyticsStrategyTitle')}
      icon={<BarChart3 size={16} />}
    >
      <div className="settings-card">
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('settings.analyticsStrategyDesc')}
        </p>

        <div className="playback-rate-strategy-row">
          <span className="playback-rate-label">{t('settings.analyticsStrategyLabel')}</span>
          <div className="playback-rate-strategy-btns">
            {ANALYTICS_STRATEGIES.map(s => (
              <button
                key={s}
                type="button"
                className={`btn btn-sm ${strategy === s ? 'btn-primary' : 'btn-surface'}`}
                onClick={() => {
                  if (serverId) {
                    setServerStrategy(serverId, s);
                  } else {
                    setStrategy(s);
                  }
                }}
              >
                {strategyLabel(s)}
              </button>
            ))}
          </div>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: '0.75rem', lineHeight: 1.5 }}>
          {strategyDesc(strategy)}
        </p>

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

        {strategy === 'advanced' && (
          <>
            <div
              style={{
                marginTop: '0.85rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                flexWrap: 'wrap',
              }}
            >
              <span className="playback-rate-label" style={{ minWidth: 0 }}>
                {t('settings.analyticsStrategyParallelismLabel')}
              </span>
              <input
                type="range"
                min={ADVANCED_PARALLELISM_MIN}
                max={ADVANCED_PARALLELISM_MAX}
                step={1}
                value={advancedParallelism}
                onChange={e => {
                  const value = parseInt(e.target.value, 10);
                  if (serverId) {
                    setServerAdvancedParallelism(serverId, value);
                  } else {
                    setAdvancedParallelism(value);
                  }
                }}
                style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
                id="analytics-strategy-parallelism-slider"
                aria-valuemin={ADVANCED_PARALLELISM_MIN}
                aria-valuemax={ADVANCED_PARALLELISM_MAX}
                aria-valuenow={advancedParallelism}
              />
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 72 }}>
                {t('settings.analyticsStrategyParallelismValue', { n: advancedParallelism })}
              </span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: '0.5rem', lineHeight: 1.5 }}>
              {t('settings.analyticsStrategyParallelismDesc')}
            </p>

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
          </>
        )}
      </div>
    </SettingsSubSection>
  );
}
