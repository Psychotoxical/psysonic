import React from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '@/store/authStore';
import { useOrbitStore } from '@/features/orbit';
import {
  AUTODJ_OVERLAP_CAP_MAX_SEC,
  AUTODJ_OVERLAP_CAP_MIN_SEC,
} from '@/lib/audio/autodjOverlapCap';
import {
  getTransitionMode,
  setTransitionMode,
  type TransitionMode,
} from '@/features/playback/utils/playback/playbackTransition';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsSubCard, SettingsField, SettingsRow, SettingsValue } from '@/features/settings/components/SettingsSubCard';
import { SettingsSegmented, type SegmentedOption } from '@/features/settings/components/SettingsSegmented';

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

  const transitions: SegmentedOption<TransitionMode>[] = [
    { id: 'none', label: t('settings.transitionOff') },
    { id: 'gapless', label: t('settings.gapless') },
    { id: 'crossfade', label: t('settings.crossfade') },
    { id: 'autodj', label: t('settings.autoDj') },
  ];

  const overlapCapOptions: SegmentedOption<'auto' | 'limit'>[] = [
    { id: 'auto', label: t('settings.autodjOverlapCapAuto') },
    { id: 'limit', label: t('settings.autodjOverlapCapLimit') },
  ];

  return (
    <SettingsGroup>
      {hostControlled && (
        <div style={{ marginBottom: '0.6rem', fontSize: 12, color: 'var(--text-muted)' }}>
          {t('settings.transitionsHostControlled')}
        </div>
      )}
      <SettingsSegmented
        options={transitions}
        value={mode}
        onChange={setTransitionMode}
        disabled={hostControlled}
        style={hostControlled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
      />

      {mode === 'crossfade' && (
        <SettingsSubCard style={{ marginTop: '0.85rem' }}>
          <SettingsRow>
            <input
              type="range"
              min={0.1}
              max={10}
              step={0.1}
              value={auth.crossfadeSecs}
              disabled={hostControlled}
              onChange={e => auth.setCrossfadeSecs(parseFloat(e.target.value))}
              id="crossfade-secs-slider"
            />
            <SettingsValue>
              {t('settings.crossfadeSecs', { n: auth.crossfadeSecs.toFixed(1) })}
            </SettingsValue>
          </SettingsRow>
        </SettingsSubCard>
      )}
      {mode === 'autodj' && (
        <SettingsSubCard style={{ marginTop: '0.85rem' }}>
          <SettingsField desc={t('settings.autoDjDesc')} />
          <SettingsField
            label={t('settings.autodjOverlapCapTitle')}
            desc={t('settings.autodjOverlapCapDesc')}
          >
            <SettingsSegmented
              options={overlapCapOptions}
              value={auth.autodjOverlapCapMode}
              onChange={auth.setAutodjOverlapCapMode}
              disabled={hostControlled}
            />
            {auth.autodjOverlapCapMode === 'limit' && (
              <SettingsRow>
                <input
                  type="range"
                  min={AUTODJ_OVERLAP_CAP_MIN_SEC}
                  max={AUTODJ_OVERLAP_CAP_MAX_SEC}
                  step={1}
                  value={auth.autodjOverlapCapSec}
                  disabled={hostControlled}
                  onChange={e => auth.setAutodjOverlapCapSec(parseInt(e.target.value, 10))}
                  id="autodj-overlap-cap-slider"
                />
                <SettingsValue>
                  {t('settings.autodjOverlapCapSecs', { n: auth.autodjOverlapCapSec })}
                </SettingsValue>
              </SettingsRow>
            )}
          </SettingsField>
          <SettingsToggle
            label={t('settings.autodjSmoothSkip')}
            desc={t('settings.autodjSmoothSkipDesc')}
            checked={auth.autodjSmoothSkip}
            disabled={hostControlled}
            onChange={auth.setAutodjSmoothSkip}
          />
        </SettingsSubCard>
      )}
    </SettingsGroup>
  );
}
