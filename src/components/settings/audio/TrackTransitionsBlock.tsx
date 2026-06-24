import React from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../store/authStore';
import { useOrbitStore } from '../../../store/orbitStore';
import {
  AUTODJ_OVERLAP_CAP_MAX_SEC,
  AUTODJ_OVERLAP_CAP_MIN_SEC,
} from '../../../utils/playback/autodjOverlapCap';
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
 * exposes an optional overlap cap (auto vs manual limit).
 *
 * Rendered as its own top-level "Track transitions" category in the Audio tab,
 * so the boxed `SettingsGroup` is title-less — the `SettingsSubSection` header
 * names it.
 */
export function TrackTransitionsBlock({ t }: Props) {
  const auth = useAuthStore();
  const mode = getTransitionMode(auth);
  // While a guest in a live Orbit session, transitions mirror the host's and
  // are re-applied every read tick — let the user see them but not fight the
  // sync. Restored to their own on leave.
  const hostControlled = useOrbitStore(
    s => s.role === 'guest' && (s.phase === 'active' || s.phase === 'joining'),
  );

  const transitions: { id: TransitionMode; label: string }[] = [
    { id: 'none', label: t('settings.transitionOff') },
    { id: 'gapless', label: t('settings.gapless') },
    { id: 'crossfade', label: t('settings.crossfade') },
    { id: 'autodj', label: t('settings.autoDj') },
  ];

  return (
    <SettingsGroup>
      {hostControlled && (
        <div style={{ marginBottom: '0.6rem', fontSize: 12, color: 'var(--text-muted)' }}>
          {t('settings.transitionsHostControlled')}
        </div>
      )}
      <div className="settings-segmented" style={hostControlled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
        {transitions.map(item => (
          <button
            key={item.id}
            type="button"
            className={`btn ${mode === item.id ? 'btn-primary' : 'btn-ghost'}`}
            disabled={hostControlled}
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
            disabled={hostControlled}
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
          <div style={{ paddingLeft: '1rem', marginTop: '0.9rem' }}>
            <p className="settings-row-label" style={{ marginBottom: '0.45rem' }}>
              {t('settings.autodjOverlapCapTitle')}
            </p>
            <p className="settings-row-desc" style={{ marginBottom: '0.6rem' }}>
              {t('settings.autodjOverlapCapDesc')}
            </p>
            <div className="settings-segmented" style={{ marginBottom: auth.autodjOverlapCapMode === 'limit' ? '0.65rem' : 0 }}>
              <button
                type="button"
                className={`btn ${auth.autodjOverlapCapMode === 'auto' ? 'btn-primary' : 'btn-ghost'}`}
                disabled={hostControlled}
                onClick={() => auth.setAutodjOverlapCapMode('auto')}
              >
                {t('settings.autodjOverlapCapAuto')}
              </button>
              <button
                type="button"
                className={`btn ${auth.autodjOverlapCapMode === 'limit' ? 'btn-primary' : 'btn-ghost'}`}
                disabled={hostControlled}
                onClick={() => auth.setAutodjOverlapCapMode('limit')}
              >
                {t('settings.autodjOverlapCapLimit')}
              </button>
            </div>
            {auth.autodjOverlapCapMode === 'limit' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                <input
                  type="range"
                  min={AUTODJ_OVERLAP_CAP_MIN_SEC}
                  max={AUTODJ_OVERLAP_CAP_MAX_SEC}
                  step={1}
                  value={auth.autodjOverlapCapSec}
                  disabled={hostControlled}
                  onChange={e => auth.setAutodjOverlapCapSec(parseInt(e.target.value, 10))}
                  style={{ flex: 1, minWidth: 80, maxWidth: 200 }}
                  id="autodj-overlap-cap-slider"
                />
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 48 }}>
                  {t('settings.autodjOverlapCapSecs', { n: auth.autodjOverlapCapSec })}
                </span>
              </div>
            )}
          </div>
          <div style={{ paddingLeft: '1rem', marginTop: '0.7rem' }}>
            <SettingsToggle
              label={t('settings.autodjSmoothSkip')}
              desc={t('settings.autodjSmoothSkipDesc')}
              checked={auth.autodjSmoothSkip}
              disabled={hostControlled}
              onChange={auth.setAutodjSmoothSkip}
            />
          </div>
        </>
      )}
    </SettingsGroup>
  );
}
