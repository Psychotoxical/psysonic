import React from 'react';
import { Play } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '@/store/authStore';
import { TRACK_PREVIEW_LOCATIONS } from '@/store/authStoreDefaults';
import type { TrackPreviewLocation } from '@/store/authStoreTypes';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsSubCard, SettingsField, SettingsValue } from '@/features/settings/components/SettingsSubCard';

interface Props {
  t: TFunction;
}

/**
 * Track previews subsection: master toggle on top, then (when enabled)
 * a per-location toggle grid, a "start at %" slider, and a duration
 * slider. Locations come from `TRACK_PREVIEW_LOCATIONS` so adding a new
 * surface (Search, Now Playing suggestions, …) only needs a single
 * source-of-truth update.
 */
export function TrackPreviewsSection({ t }: Props) {
  const auth = useAuthStore();

  return (
    <SettingsSubSection
      title={t('settings.trackPreviewsTitle')}
      icon={<Play size={16} />}
    >
      <div className="settings-card">
        <SettingsGroup>
          <SettingsToggle
            label={t('settings.trackPreviewsToggle')}
            desc={t('settings.trackPreviewsDesc')}
            checked={auth.trackPreviewsEnabled}
            onChange={auth.setTrackPreviewsEnabled}
          />

          {auth.trackPreviewsEnabled && (
            <SettingsSubCard style={{ marginTop: '0.85rem' }}>
              <SettingsField
                label={t('settings.trackPreviewLocationsTitle')}
                desc={t('settings.trackPreviewLocationsDesc')}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {TRACK_PREVIEW_LOCATIONS.map((loc: TrackPreviewLocation) => (
                    <div key={loc} className="settings-toggle-row" style={{ padding: '6px var(--space-3)' }}>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {t(`settings.trackPreviewLocation_${loc}`)}
                      </div>
                      <label className="toggle-switch" aria-label={t(`settings.trackPreviewLocation_${loc}`)}>
                        <input type="checkbox" checked={auth.trackPreviewLocations[loc]}
                          onChange={e => auth.setTrackPreviewLocation(loc, e.target.checked)} />
                        <span className="toggle-track" />
                      </label>
                    </div>
                  ))}
                </div>
              </SettingsField>

              <SettingsField
                label={t('settings.trackPreviewStart')}
                desc={t('settings.trackPreviewStartDesc')}
                row
              >
                <input
                  type="range"
                  min={0}
                  max={0.9}
                  step={0.01}
                  value={auth.trackPreviewStartRatio}
                  onChange={e => auth.setTrackPreviewStartRatio(parseFloat(e.target.value))}
                  aria-label={t('settings.trackPreviewStart')}
                />
                <SettingsValue>{Math.round(auth.trackPreviewStartRatio * 100)}%</SettingsValue>
              </SettingsField>

              <SettingsField
                label={t('settings.trackPreviewDuration')}
                desc={t('settings.trackPreviewDurationDesc')}
                row
              >
                <input
                  type="range"
                  min={5}
                  max={60}
                  step={1}
                  value={auth.trackPreviewDurationSec}
                  onChange={e => auth.setTrackPreviewDurationSec(parseInt(e.target.value, 10))}
                  aria-label={t('settings.trackPreviewDuration')}
                />
                <SettingsValue>
                  {t('settings.trackPreviewDurationSecs', { n: auth.trackPreviewDurationSec })}
                </SettingsValue>
              </SettingsField>
            </SettingsSubCard>
          )}
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
