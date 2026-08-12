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
  const isServerIndex = step === 'serverIndex';
  const isGenreTags = step === 'genreTags';
  const isScopeBrowseProjection = step === 'scopeBrowseProjection';
  const migrationTitle = isGenreTags
    ? t('migration.genreTagsTitle')
    : isScopeBrowseProjection
      ? t('migration.scopeBrowseProjectionTitle')
      : t('migration.migrating');
  const migrationBody = isGenreTags
    ? t('migration.genreTagsBody')
    : isScopeBrowseProjection
      ? t('migration.scopeBrowseProjectionBody')
      : (isServerIndex && progress ? `${progress.stage} - ${progress.table}` : t('migration.working'));
  const activeProgress = isGenreTags
    ? genreTagsProgress
    : isScopeBrowseProjection
      ? scopeBrowseProjectionProgress
      : isServerIndex
        ? progress
        : null;

  const migratedRows = isServerIndex
    ? (inspect?.library.totalLegacyRows ?? 0) + (inspect?.analysis.totalLegacyRows ?? 0)
    : 0;
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
        {phase === 'inspecting' && (
          <>
            <h3>{isGenreTags ? t('migration.genreTagsTitle') : isScopeBrowseProjection ? t('migration.scopeBrowseProjectionTitle') : t('migration.preparing')}</h3>
            <p style={{ color: 'var(--text-muted)' }}>
              {isGenreTags ? t('migration.genreTagsBody') : isScopeBrowseProjection ? t('migration.scopeBrowseProjectionBody') : t('migration.preparingBody')}
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
            {isServerIndex && inspect?.hasSkippedUnknownServerRows ? (
              <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
                {t('migration.skippedRows')}
              </p>
            ) : null}
          </>
        )}
        {phase === 'error' && (
          <>
            <h3>{isGenreTags ? t('migration.genreTagsFailed') : isScopeBrowseProjection ? t('migration.scopeBrowseProjectionFailed') : t('migration.failed')}</h3>
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
  const isBlocking = phase === 'inspecting' || phase === 'running' || phase === 'error';
  return (
    <>
      {children}
      {isBlocking ? <MigrationModal /> : null}
    </>
  );
}
