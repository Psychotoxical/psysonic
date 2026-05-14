import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, HardDrive, Upload } from 'lucide-react';
import { exportBackup, importBackup } from '../../utils/export/backup';
import { showToast } from '../../utils/ui/toast';

export function BackupSection() {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    setExporting(true);
    try {
      const path = await exportBackup();
      if (path) showToast(t('settings.backupSuccess'), 3000, 'info');
    } catch (e) {
      console.error('Export failed', e);
      showToast(t('settings.backupImportError'), 4000, 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    if (!window.confirm(t('settings.backupImportConfirm'))) return;
    setImporting(true);
    try {
      await importBackup();
      // importBackup reloads the page — this toast will briefly show before reload
      showToast(t('settings.backupImportSuccess'), 3000, 'info');
    } catch (e) {
      console.error('Import failed', e);
      showToast(t('settings.backupImportError'), 4000, 'error');
      setImporting(false);
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <HardDrive size={18} />
        <h2>{t('settings.backupTitle')}</h2>
      </div>

      {/* Export */}
      <div className="settings-card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <div>
            <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{t('settings.backupExport')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('settings.backupExportDesc')}</div>
          </div>
          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={exporting}
            style={{ flexShrink: 0 }}
          >
            <Upload size={14} />
            {exporting ? '…' : t('settings.backupExport')}
          </button>
        </div>
      </div>

      {/* Import */}
      <div className="settings-card">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <div>
            <div style={{ fontWeight: 500, marginBottom: '0.25rem' }}>{t('settings.backupImport')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('settings.backupImportDesc')}</div>
          </div>
          <button
            className="btn btn-surface"
            onClick={handleImport}
            disabled={importing}
            style={{ flexShrink: 0 }}
          >
            <Download size={14} />
            {importing ? '…' : t('settings.backupImport')}
          </button>
        </div>
      </div>
    </section>
  );
}
