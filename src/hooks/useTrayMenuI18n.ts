import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

/**
 * Push the tray context menu's localized labels into Rust on mount and on
 * every `languageChanged` event so the system tray follows the in-app
 * language selection.
 */
export function useTrayMenuI18n(): void {
  const { t, i18n } = useTranslation();
  useEffect(() => {
    const apply = () => {
      invoke('set_tray_menu_labels', {
        playPause: t('tray.playPause'),
        next: t('tray.nextTrack'),
        previous: t('tray.previousTrack'),
        showHide: t('tray.showHide'),
        quit: t('tray.exitPsysonic'),
        nothingPlaying: t('tray.nothingPlaying'),
      }).catch(() => {});
    };
    apply();
    i18n.on('languageChanged', apply);
    return () => { i18n.off('languageChanged', apply); };
  }, [t, i18n]);
}
