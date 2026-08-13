import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { retryBlockingMigration } from '@/app/hooks/useMigrationOrchestrator';
import { useMigrationStore } from '../store/migrationStore';

function MigrationModal() {
  const { t } = useTranslation();
  const phase = useMigrationStore(s => s.phase);
  const step = useMigrationStore(s => s.step);
  const progress = useMigrationStore(s => s.progress);
  const genreTagsProgress = useMigrationStore(s => s.genreTagsProgress);
  const scopeBrowseProjectionProgress = useMigrationStore(s => s.scopeBrowseProjectionProgress);
  const inspect = useMigrationStore(s => s.inspect);
  const error = useMigrationStore(s => s.lastError);
  const isNavidromeCanonical = step === 'navidromeCanonical';
  const isGenreTags = step === 'genreTags';
  const isScopeBrowseProjection = step === 'scopeBrowseProjection';
  const migrationTitle = isNavidromeCanonical
    ? t('migration.migrating')
    : isGenreTags
    ? t('migration.genreTagsTitle')
    : isScopeBrowseProjection
      ? t('migration.scopeBrowseProjectionTitle')
      : t('migration.migrating');
  const migrationBody = isNavidromeCanonical
    ? t('migration.working')
    : isGenreTags
    ? t('migration.genreTagsBody')
    : isScopeBrowseProjection
      ? t('migration.scopeBrowseProjectionBody')
      : (progress ? `${progress.stage} - ${progress.table}` : t('migration.working'));
  const activeProgress = isNavidromeCanonical
    ? null
    : isGenreTags ? genreTagsProgress : isScopeBrowseProjection ? scopeBrowseProjectionProgress : progress;

  const migratedRows = (inspect?.library.totalLegacyRows ?? 0) + (inspect?.analysis.totalLegacyRows ?? 0);
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.65)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 99999,
    }}
    >
      <div style={{
        width: 'min(560px, 92vw)',
        background: 'var(--bg-card)',
        borderRadius: 14,
        padding: '1.5rem 1.75rem',
        color: 'var(--text)',
      }}
      >
        {(phase === 'idle' || phase === 'inspecting') && (
          <>
             <h3>{isNavidromeCanonical ? t('migration.preparing') : isGenreTags ? t('migration.genreTagsTitle') : isScopeBrowseProjection ? t('migration.scopeBrowseProjectionTitle') : t('migration.preparing')}</h3>
            <p style={{ color: 'var(--text-muted)' }}>
               {isNavidromeCanonical ? t('migration.preparingBody') : isGenreTags ? t('migration.genreTagsBody') : isScopeBrowseProjection ? t('migration.scopeBrowseProjectionBody') : t('migration.preparingBody')}
            </p>
          </>
        )}
        {phase === 'running' && (
          <>
            <h3>{migrationTitle}</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {migrationBody}
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              {activeProgress ? `${activeProgress.done} / ${activeProgress.total}` : t('migration.working')}
            </p>
            {!isGenreTags && inspect?.hasSkippedUnknownServerRows ? (
              <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                {t('migration.skippedRows')}
              </p>
            ) : null}
          </>
        )}
        {phase === 'error' && (
          <>
             <h3>{isNavidromeCanonical ? t('migration.failed') : isGenreTags ? t('migration.genreTagsFailed') : isScopeBrowseProjection ? t('migration.scopeBrowseProjectionFailed') : t('migration.failed')}</h3>
            <p style={{ color: 'var(--text-muted)' }}>{String(error ?? '').slice(0, 200)}</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn-primary" onClick={() => retryBlockingMigration()}>{t('migration.retry')}</button>
              <button className="btn-surface" onClick={() => navigator.clipboard.writeText(String(error ?? ''))}>
                {t('migration.copyDetails')}
              </button>
            </div>
          </>
        )}
        {phase === 'completed' && (
          <>
            <h3>{t('migration.complete')}</h3>
            <p style={{ color: 'var(--text-muted)' }}>{t('migration.completeRows', { count: migratedRows })}</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function BlockingMigrationGate({ children }: { children: ReactNode }) {
  const phase = useMigrationStore(s => s.phase);
  const isBlocking = phase !== 'completed';
  return isBlocking ? <MigrationModal /> : children;
}
