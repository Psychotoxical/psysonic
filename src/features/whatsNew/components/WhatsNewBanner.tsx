import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { version } from '@/../package.json';
import { useAuthStore } from '@/store/authStore';

interface Props {
  collapsed?: boolean;
}

/**
 * Sidebar pill shown above Now Playing while the current app version hasn't
 * been opened yet. Clicking opens the What's New page; X dismisses.
 *
 * Uses a fixed neutral palette so it looks identical across every theme.
 */
export default function WhatsNewBanner({ collapsed }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lastSeen = useAuthStore(s => s.lastSeenChangelogVersion);
  const setLastSeen = useAuthStore(s => s.setLastSeenChangelogVersion);
  const showOnUpdate = useAuthStore(s => s.showChangelogOnUpdate);

  if (!showOnUpdate || lastSeen === version) return null;

  const dismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setLastSeen(version);
  };

  const open = () => navigate('/whats-new');

  if (collapsed) {
    return (
      <button
        type="button"
        className="whats-new-banner whats-new-banner--collapsed"
        onClick={open}
        data-tooltip={t('whatsNew.bannerCollapsed', { version })}
        data-tooltip-pos="bottom"
      >
        <Sparkles size={16} />
      </button>
    );
  }

  return (
    <button type="button" className="whats-new-banner" onClick={open}>
      <Sparkles size={14} className="whats-new-banner__icon" />
      <span className="whats-new-banner__text">
        <span className="whats-new-banner__title">{t('whatsNew.bannerTitle')}</span>
        <span className="whats-new-banner__version">v{version}</span>
      </span>
      <span
        className="whats-new-banner__dismiss"
        role="button"
        aria-label={t('whatsNew.dismiss')}
        onClick={dismiss}
      >
        <X size={12} />
      </span>
    </button>
  );
}
