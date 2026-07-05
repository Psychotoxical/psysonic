import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Paintbrush, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useThemeUpdates, themeUpdateSignature } from '@/features/settings/hooks/useThemeUpdates';

interface Props {
  collapsed?: boolean;
}

/**
 * Sidebar pill shown above Now Playing while one or more installed community
 * themes have a newer version in the store. Clicking opens Settings → Themes;
 * X dismisses until a new update changes the set (see {@link themeUpdateSignature}).
 *
 * Sibling of {@link WhatsNewBanner}; reuses its `.whats-new-banner` styling.
 */
export default function ThemeUpdateBanner({ collapsed }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const updates = useThemeUpdates();
  const lastDismissed = useAuthStore(s => s.lastDismissedThemeUpdateSig);
  const setDismissed = useAuthStore(s => s.setLastDismissedThemeUpdateSig);

  const count = updates.length;
  const sig = themeUpdateSignature(updates);
  if (count === 0 || sig === lastDismissed) return null;

  const open = () => navigate('/settings', { state: { tab: 'themes' } });
  const dismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissed(sig);
  };

  if (collapsed) {
    return (
      <button
        type="button"
        className="whats-new-banner whats-new-banner--collapsed theme-update-banner--collapsed"
        onClick={open}
        data-tooltip={t('sidebar.themeUpdatesTooltip')}
        data-tooltip-pos="bottom"
      >
        <Paintbrush size={16} />
        <span className="theme-update-banner__count theme-update-banner__count--dot" aria-hidden>
          {count > 9 ? '9+' : count}
        </span>
      </button>
    );
  }

  return (
    <button type="button" className="whats-new-banner theme-update-banner" onClick={open}>
      <Paintbrush size={14} className="whats-new-banner__icon" />
      <span className="whats-new-banner__text">
        <span className="whats-new-banner__title">{t('sidebar.themeUpdatesTitle')}</span>
      </span>
      <span className="theme-update-banner__count" aria-hidden>{count}</span>
      <span
        className="whats-new-banner__dismiss"
        role="button"
        aria-label={t('sidebar.themeUpdatesDismiss')}
        onClick={dismiss}
      >
        <X size={12} />
      </span>
    </button>
  );
}
