import { Cloud, CloudOff } from 'lucide-react';
import { useDevOfflineBrowseStore } from '../store/devOfflineBrowseStore';

/** DEV-only: simulate offline browse without disconnecting the server probe. */
export default function DevNetworkModeToggle() {
  const forceOffline = useDevOfflineBrowseStore(s => s.forceOffline);
  const toggle = useDevOfflineBrowseStore(s => s.toggleForceOffline);

  if (!import.meta.env.DEV) return null;

  return (
    <button
      type="button"
      className={`dev-network-mode-toggle${forceOffline ? ' dev-network-mode-toggle--offline' : ''}`}
      onClick={toggle}
      title={forceOffline ? 'DEV: forced offline browse (click for online)' : 'DEV: online browse (click to force offline)'}
      aria-pressed={forceOffline}
    >
      {forceOffline ? <CloudOff size={16} aria-hidden /> : <Cloud size={16} aria-hidden />}
      <span>{forceOffline ? 'Offline' : 'Online'}</span>
    </button>
  );
}
