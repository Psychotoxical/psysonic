import React from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../store/authStore';
import {
  getTransitionMode,
  setTransitionMode,
  type TransitionMode,
} from '../../../utils/playback/playbackTransition';
import { SettingsGroup } from '../SettingsGroup';
import { SettingsToggle } from '../SettingsToggle';

interface Props {
  t: TFunction;
}

/**
 * Track-transition picker. Crossfade, AutoDJ and Gapless are mutually
 * exclusive — only one can be active — so they are presented as a single
 * `Off | Gapless | Crossfade | AutoDJ` segmented control backed by the shared
 * transition-mode helper.
 *
 * Classic crossfade exposes the seconds slider; AutoDJ is content-driven and
 * has no duration to configure (just a short explainer + the smooth-skip
 * toggle).
 *
 * Rendered as its own top-level "Track transitions" category in the Audio tab,
 * so the boxed `SettingsGroup` is title-less — the `SettingsSubSection` header
 * names it.
 */
export function TrackTransitionsBlock({ t }: Props) {
  const auth = useAuthStore();
  const mode = getTransitionMode(auth);

  const transitions: { id: TransitionMode; label: string }[] = [
    { id: 'none', label: t('settings.transitionOff') },
    { id: 'gapless', label: t('settings.gapless') },
    { id: 'crossfade', label: t('settings.crossfade') },
    { id: 'autodj', label: t('settings.autoDj') },
  ];

  return (
    <SettingsGroup>
      <div className="settings-segmented">
        {transitions.map(item => (
          <button
            key={item.id}
            type="button"
            className={`btn ${mode === item.id ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setTransitionMode(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {mode === 'crossfade' && (
        <div style={{ paddingLeft: '1rem', marginTop: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.1}
            value={auth.crossfadeSecs}
            onChange={e => auth.setCrossfadeSecs(parseFloat(e.target.value))}
            style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
            id="crossfade-secs-slider"
          />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 36 }}>
            {t('settings.crossfadeSecs', { n: auth.crossfadeSecs.toFixed(1) })}
          </span>
        </div>
      )}
      {mode === 'autodj' && (
        <>
          <div style={{ paddingLeft: '1rem', fontSize: 12, color: 'var(--text-muted)', marginTop: '0.7rem' }}>
            {t('settings.autoDjDesc')}
          </div>
          <div style={{ paddingLeft: '1rem', marginTop: '0.7rem' }}>
            <SettingsToggle
              label={t('settings.autodjSmoothSkip')}
              desc={t('settings.autodjSmoothSkipDesc')}
              checked={auth.autodjSmoothSkip}
              onChange={auth.setAutodjSmoothSkip}
            />
          </div>
        </>
      )}
    </SettingsGroup>
  );
}
