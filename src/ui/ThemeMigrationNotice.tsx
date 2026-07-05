import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ConfirmModal from './ConfirmModal';
import { readThemeMigrationNotice, clearThemeMigrationNotice } from '@/lib/themes/themeMigration';

/**
 * One-time, dismissible notice shown after the slim-bundle migration reset a
 * theme that is now store-only or retired. Reads the flag written by
 * `migrateThemeSelection` at startup, points the user at the Theme Store, and
 * clears the flag on dismiss so it never shows again.
 */
export default function ThemeMigrationNotice() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [themes] = useState(() => readThemeMigrationNotice());
  const [open, setOpen] = useState(themes.length > 0);

  if (!open) return null;

  const close = () => {
    clearThemeMigrationNotice();
    setOpen(false);
  };

  return (
    <ConfirmModal
      open={open}
      title={t('settings.themeMigrationNoticeTitle')}
      message={t('settings.themeMigrationNoticeBody', { themes: themes.join(', ') })}
      confirmLabel={t('settings.themeMigrationNoticeOpen')}
      cancelLabel={t('common.close')}
      onConfirm={() => {
        close();
        navigate('/settings', { state: { tab: 'themes' } });
      }}
      onCancel={close}
    />
  );
}
