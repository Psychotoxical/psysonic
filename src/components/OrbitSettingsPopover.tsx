import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Shuffle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import { updateOrbitSettings, triggerOrbitShuffleNow } from '../utils/orbit';
import { ORBIT_DEFAULT_SETTINGS, ORBIT_SHUFFLE_INTERVAL_PRESETS_MIN, type OrbitShuffleIntervalMin } from '../api/orbit';
import { showToast } from '../utils/ui/toast';

interface Props {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * Host-only popover anchored below the settings button in the Orbit bar.
 * Two toggles; writes are pushed immediately to Navidrome via
 * `updateOrbitSettings`.
 */
export default function OrbitSettingsPopover({ anchorRef, onClose }: Props) {
  const { t } = useTranslation();
  const settings = useOrbitStore(s => s.state?.settings) ?? ORBIT_DEFAULT_SETTINGS;
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const anchor = anchorRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        top:   anchor.bottom + 12,
        right: Math.max(8, window.innerWidth - anchor.right),
        zIndex: 9999,
      }
    : { display: 'none' };

  return createPortal(
    <div ref={popRef} className="orbit-settings-pop" style={style} role="menu">
      <div className="orbit-settings-pop__head">{t('orbit.settingsTitle')}</div>

      <label className="orbit-settings-pop__row">
        <div className="orbit-settings-pop__text">
          <div className="orbit-settings-pop__label">{t('orbit.settingAutoApprove')}</div>
          <div className="orbit-settings-pop__hint">{t('orbit.settingAutoApproveHint')}</div>
        </div>
        <span className="toggle-switch">
          <input
            type="checkbox"
            checked={settings.autoApprove}
            onChange={e => { void updateOrbitSettings({ autoApprove: e.target.checked }); }}
          />
          <span className="toggle-track" />
        </span>
      </label>

      <label className="orbit-settings-pop__row">
        <div className="orbit-settings-pop__text">
          <div className="orbit-settings-pop__label">{t('orbit.settingAutoShuffle')}</div>
          <div className="orbit-settings-pop__hint">{t('orbit.settingAutoShuffleHint')}</div>
        </div>
        <span className="toggle-switch">
          <input
            type="checkbox"
            checked={settings.autoShuffle}
            onChange={e => { void updateOrbitSettings({ autoShuffle: e.target.checked }); }}
          />
          <span className="toggle-track" />
        </span>
      </label>

      <div className="orbit-settings-pop__row orbit-settings-pop__row--stacked">
        <div className="orbit-settings-pop__text">
          <div className="orbit-settings-pop__label">{t('orbit.settingShuffleInterval')}</div>
          <div className="orbit-settings-pop__hint">{t('orbit.settingShuffleIntervalHint')}</div>
        </div>
        <div
          className="orbit-settings-pop__preset-group"
          role="radiogroup"
          aria-label={t('orbit.settingShuffleInterval')}
        >
          {ORBIT_SHUFFLE_INTERVAL_PRESETS_MIN.map(min => {
            const active = (settings.shuffleIntervalMin ?? 15) === min;
            return (
              <button
                key={min}
                type="button"
                role="radio"
                aria-checked={active}
                className={`orbit-settings-pop__preset${active ? ' is-active' : ''}`}
                disabled={!settings.autoShuffle}
                onClick={() => {
                  void updateOrbitSettings({ shuffleIntervalMin: min as OrbitShuffleIntervalMin });
                }}
              >
                {t('orbit.settingShuffleIntervalValue', { count: min })}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        className="orbit-settings-pop__action"
        onClick={() => {
          void triggerOrbitShuffleNow();
          showToast(t('orbit.toastShuffled'), 2200, 'info');
          onClose();
        }}
      >
        <Shuffle size={13} />
        <span>{t('orbit.settingShuffleNow')}</span>
      </button>
    </div>,
    document.body,
  );
}
