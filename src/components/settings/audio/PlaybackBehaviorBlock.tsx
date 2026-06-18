import React from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../store/authStore';
import {
  getTransitionMode,
  setTransitionMode,
  type TransitionMode,
} from '../../../utils/playback/playbackTransition';

interface Props {
  t: TFunction;
}

/**
 * Track-transition picker. Crossfade, AutoDJ and Gapless are mutually
 * exclusive — only one can be active — so they are presented as a single
 * `Off | Gapless | Crossfade | AutoDJ` segmented control (mirroring the
 * Normalization picker above it) backed by the shared transition-mode helper.
 *
 * Classic crossfade exposes the seconds slider; AutoDJ is content-driven and
 * has no duration to configure (just a short explainer). The
 * `preservePlayNextOrder` toggle is independent and grouped under its own
 * "Queue behaviour" heading at the bottom.
 */
export function PlaybackBehaviorBlock({ t }: Props) {
  const auth = useAuthStore();
  const mode = getTransitionMode(auth);

  const transitions: { id: TransitionMode; label: string }[] = [
    { id: 'none', label: t('settings.transitionOff') },
    { id: 'gapless', label: t('settings.gapless') },
    { id: 'crossfade', label: t('settings.crossfade') },
    { id: 'autodj', label: t('settings.autoDj') },
  ];

  return (
    <>
      <div className="settings-group">
        <div className="settings-group-title">{t('settings.transitionsTitle')}</div>
        <div className="settings-group-desc">{t('settings.transitionsDesc')}</div>

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
          <div style={{ paddingLeft: '1rem', fontSize: 12, color: 'var(--text-muted)', marginTop: '0.7rem' }}>
            {t('settings.autoDjDesc')}
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-title">{t('settings.queueBehaviourTitle')}</div>

        <div className="settings-toggle-row">
          <div>
            <div style={{ fontWeight: 500 }}>
              {t('settings.preservePlayNextOrder')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('settings.preservePlayNextOrderDesc')}
            </div>
          </div>
          <label className="toggle-switch" aria-label={t('settings.preservePlayNextOrder')}>
            <input type="checkbox" checked={auth.preservePlayNextOrder}
              onChange={e => auth.setPreservePlayNextOrder(e.target.checked)} />
            <span className="toggle-track" />
          </label>
        </div>
      </div>
    </>
  );
}
