import { FolderOpen } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useDownloadModalStore } from '@/features/offline/store/downloadModalStore';
import { useAuthStore } from '@/store/authStore';

export default function DownloadFolderModal() {
  const { isOpen, folder, remember, setFolder, setRemember, confirm, cancel } = useDownloadModalStore();
  const setDownloadFolder = useAuthStore(s => s.setDownloadFolder);
  const { t } = useTranslation();

  const handleBrowse = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('common.chooseDownloadFolder') });
    if (selected && typeof selected === 'string') setFolder(selected);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="eq-popup-backdrop" onClick={cancel} style={{ zIndex: 210 }} />
      <div className="eq-popup" style={{ zIndex: 211, width: 'min(480px, 92vw)', gap: 0 }}>
        <div className="eq-popup-header">
          <span className="eq-popup-title">{t('common.chooseDownloadFolder')}</span>
        </div>

        <div style={{ padding: '16px 0 12px' }}>
          <div className="download-folder-pick-row">
            <span className="download-folder-path">
              {folder || t('common.noFolderSelected')}
            </span>
            <button className="btn btn-ghost" onClick={handleBrowse} style={{ flexShrink: 0 }}>
              <FolderOpen size={15} /> {t('settings.pickFolder')}
            </button>
          </div>

          <label className="download-remember-row">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            <span>{t('common.rememberDownloadFolder')}</span>
          </label>
        </div>

        <div className="download-modal-actions">
          <button className="btn btn-ghost" onClick={cancel}>{t('common.cancel')}</button>
          <button
            className="btn btn-primary"
            onClick={() => confirm(setDownloadFolder)}
            disabled={!folder}
          >
            {t('common.download')}
          </button>
        </div>
      </div>
    </>
  );
}
