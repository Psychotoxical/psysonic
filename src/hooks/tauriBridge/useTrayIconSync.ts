import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../../store/authStore';

/** Sync tray-icon visibility with the user's stored setting. Runs once on mount
 * (initial sync) and again whenever the setting changes. */
export function useTrayIconSync() {
  const showTrayIcon = useAuthStore(s => s.showTrayIcon);
  useEffect(() => {
    invoke('toggle_tray_icon', { show: showTrayIcon }).catch(console.error);
  }, [showTrayIcon]);
}
