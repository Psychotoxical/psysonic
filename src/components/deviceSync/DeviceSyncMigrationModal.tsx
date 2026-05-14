import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import type {
  MigrationPair, MigrationPhase, MigrationResult,
} from '../../utils/deviceSync/runDeviceSyncMigration';

interface Props {
  migrationPhase: MigrationPhase;
  migrationOldTemplate: string;
  migrationPairs: MigrationPair[];
  migrationCollisions: MigrationPair[];
  migrationUnchanged: number;
  migrationResult: MigrationResult | null;
  executeMigration: () => Promise<void>;
  closeMigration: () => void;
}

export default function DeviceSyncMigrationModal({
  migrationPhase, migrationOldTemplate, migrationPairs, migrationCollisions,
  migrationUnchanged, migrationResult, executeMigration, closeMigration,
}: Props) {
  const { t } = useTranslation();

  if (migrationPhase === 'closed') return null;

  return (
    <div className="modal-overlay" onClick={migrationPhase === 'executing' ? undefined : closeMigration}>
      <div className="modal-content device-sync-migrate-modal" onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">{t('deviceSync.migrateTitle', { defaultValue: 'Reorganize existing files' })}</h2>
        <div className="device-sync-migrate-body">
          {migrationPhase === 'loading' && (
            <div className="device-sync-migrate-loading">
              <Loader2 size={18} className="spin" />
              <span>{t('deviceSync.migrateLoading', { defaultValue: 'Analyzing existing files…' })}</span>
            </div>
          )}
          {migrationPhase === 'nothing' && (
            <div className="device-sync-migrate-nothing">
              {migrationOldTemplate ? (
                t('deviceSync.migrateNothingToDo', { defaultValue: 'All existing files already match the new scheme — nothing to do.' })
              ) : (
                t('deviceSync.migrateNoTemplate', { defaultValue: 'No legacy filename template found on the device. Migration only applies when the stick was synced with a Psysonic version that supported custom templates.' })
              )}
            </div>
          )}
          {migrationPhase === 'preview' && (
            <>
              <div className="device-sync-migrate-summary">
                <div>
                  <strong>{migrationPairs.length}</strong>{' '}
                  {t('deviceSync.migrateFilesToRename', { defaultValue: 'files will be renamed' })}
                </div>
                {migrationUnchanged > 0 && (
                  <div className="muted">
                    {t('deviceSync.migrateUnchanged', {
                      defaultValue: '{{n}} files are already at the correct path',
                      n: migrationUnchanged,
                    })}
                  </div>
                )}
                {migrationCollisions.length > 0 && (
                  <div className="device-sync-migrate-warning">
                    <AlertCircle size={14} />
                    {t('deviceSync.migrateCollisions', {
                      defaultValue: '{{n}} files cannot be renamed automatically (multiple tracks map to the same target). They will be left untouched — the next sync re-downloads them into the correct location.',
                      n: migrationCollisions.length,
                    })}
                  </div>
                )}
              </div>
              <div className="device-sync-migrate-preview-note">
                {t('deviceSync.migratePreviewNote', {
                  defaultValue: 'Old template: {{tpl}}',
                  tpl: migrationOldTemplate,
                })}
              </div>
            </>
          )}
          {migrationPhase === 'executing' && (
            <div className="device-sync-migrate-loading">
              <Loader2 size={18} className="spin" />
              <span>{t('deviceSync.migrateExecuting', { defaultValue: 'Renaming files…' })}</span>
            </div>
          )}
          {migrationPhase === 'done' && migrationResult && (
            <div className="device-sync-migrate-result">
              <div className="device-sync-migrate-result-line">
                <CheckCircle2 size={14} className="positive" />
                {t('deviceSync.migrateSuccess', {
                  defaultValue: '{{n}} files renamed successfully',
                  n: migrationResult.ok,
                })}
              </div>
              {migrationResult.failed > 0 && (
                <div className="device-sync-migrate-result-line">
                  <AlertCircle size={14} className="danger" />
                  {t('deviceSync.migrateFailed', {
                    defaultValue: '{{n}} renames failed',
                    n: migrationResult.failed,
                  })}
                </div>
              )}
              {migrationResult.errors.length > 0 && (
                <details className="device-sync-migrate-errors">
                  <summary>{t('deviceSync.migrateShowErrors', { defaultValue: 'Show errors' })}</summary>
                  <ul>
                    {migrationResult.errors.slice(0, 50).map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                    {migrationResult.errors.length > 50 && (
                      <li>… {migrationResult.errors.length - 50} more</li>
                    )}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
        <div className="device-sync-migrate-footer">
          {migrationPhase === 'preview' && (
            <>
              <button className="btn btn-ghost" onClick={closeMigration}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={executeMigration} disabled={migrationPairs.length === 0}>
                {t('deviceSync.migrateStart', { defaultValue: 'Start renaming' })}
              </button>
            </>
          )}
          {(migrationPhase === 'done' || migrationPhase === 'nothing') && (
            <button className="btn btn-primary" onClick={closeMigration}>{t('common.close')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
