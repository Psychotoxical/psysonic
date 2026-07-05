import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock3, Download, Upload } from 'lucide-react';
import { createPortal } from 'react-dom';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';
import {
  exportBackupToPath,
  importAnyBackupFromPath,
  pickBackupExportPath,
  pickBackupImportPath,
} from '@/features/settings/utils/backup';
import { showToast } from '@/lib/dom/toast';

type BackupMode = 'full' | 'library' | 'config';
type BackupAction = 'export' | 'import';

export function BackupSection() {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [mode, setMode] = useState<BackupMode>('full');
  const [busyAction, setBusyAction] = useState<BackupAction | null>(null);

  const waitForPaint = async () => {
    await new Promise(resolve => window.setTimeout(resolve, 0));
  };

  const busy = exporting || importing;

  const handleExport = async () => {
    const exportMode = mode;
    const path = await pickBackupExportPath(exportMode);
    if (!path) return;
    setBusyAction('export');
    setExporting(true);
    try {
      await waitForPaint();
      await exportBackupToPath(exportMode, path);
      const successKey = exportMode === 'full'
        ? 'settings.backupFullExportSuccess'
        : exportMode === 'library'
          ? 'settings.backupLibraryExportSuccess'
          : 'settings.backupSuccess';
      showToast(t(successKey), 3000, 'info');
    } catch (e) {
      console.error('Export failed', e);
      const errorKey = mode === 'full'
        ? 'settings.backupFullImportError'
        : mode === 'library'
          ? 'settings.backupLibraryImportError'
          : 'settings.backupImportError';
      showToast(t(errorKey), 4000, 'error');
    } finally {
      setExporting(false);
      setBusyAction(null);
    }
  };

  const handleImport = async () => {
    if (!window.confirm(t('settings.backupImportAnyConfirm'))) return;
    const path = await pickBackupImportPath();
    if (!path) return;
    setBusyAction('import');
    setImporting(true);
    try {
      await waitForPaint();
      const importedKind = await importAnyBackupFromPath(path);
      if (importedKind === 'full') {
        showToast(t('settings.backupFullImportSuccess'), 3000, 'info');
      } else if (importedKind === 'databases') {
        showToast(t('settings.backupLibraryImportSuccess'), 3000, 'info');
      } else if (importedKind === 'config') {
        showToast(t('settings.backupImportSuccess'), 3000, 'info');
      }
    } catch (e) {
      console.error('Import failed', e);
      showToast(t('settings.backupImportError'), 4000, 'error');
    } finally {
      setImporting(false);
      setBusyAction(null);
    }
  };

  const modeTitle = mode === 'full'
    ? t('settings.backupModeFull')
    : mode === 'library'
      ? t('settings.backupModeLibrary')
      : t('settings.backupModeConfig');
  const modeDesc = mode === 'full'
    ? t('settings.backupFullDesc')
    : mode === 'library'
      ? t('settings.backupLibraryExportDesc')
      : t('settings.backupExportDesc');
  const exportLabel = mode === 'full'
    ? t('settings.backupFullExport')
    : mode === 'library'
      ? t('settings.backupLibraryExport')
      : t('settings.backupExport');
  const importLabel = t('settings.backupImportAny');
  const overlayTitle = busyAction === 'import'
    ? t('settings.backupOverlayImportTitle')
    : t('settings.backupOverlayExportTitle');
  const overlayHint = t('settings.backupOverlayHint');
  const busyOverlay = busy && typeof document !== 'undefined'
    ? createPortal(
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.38)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '16px',
          zIndex: 99999,
          pointerEvents: 'all',
          boxSizing: 'border-box',
        }}
        aria-live="polite"
        aria-busy="true"
      >
        <div
          className="settings-card"
          style={{
            width: 'clamp(280px, 52vw, 560px)',
            maxWidth: 'calc(100vw - 32px)',
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '999px',
              background: 'var(--surface-3)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '0.6rem',
            }}
          >
            <Clock3 size={18} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: '0.5rem' }}>{overlayTitle}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{overlayHint}</div>
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <div className="settings-card">
      <SettingsGroup>
        <div className="settings-segmented" style={{ marginBottom: '0.85rem' }}>
          {(['full', 'library', 'config'] as BackupMode[]).map(candidate => (
            <button
              key={candidate}
              type="button"
              className={`btn ${mode === candidate ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setMode(candidate)}
            >
              {candidate === 'full'
                ? t('settings.backupModeFull')
                : candidate === 'library'
                  ? t('settings.backupModeLibrary')
                  : t('settings.backupModeConfig')}
            </button>
          ))}
        </div>

        <SettingsSubCard>
          <SettingsField label={modeTitle} desc={modeDesc}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={handleExport}
                disabled={exporting}
              >
                <Upload size={14} />
                {exporting ? '…' : exportLabel}
              </button>
              <button
                className="btn btn-surface"
                onClick={handleImport}
                disabled={importing}
              >
                <Download size={14} />
                {importing ? '…' : importLabel}
              </button>
            </div>
          </SettingsField>
        </SettingsSubCard>
      </SettingsGroup>
      {busyOverlay}
    </div>
  );
}
