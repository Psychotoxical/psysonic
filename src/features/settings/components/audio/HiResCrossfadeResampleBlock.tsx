import {
  HI_RES_CROSSFADE_RESAMPLE_OPTIONS,
  type HiResCrossfadeResampleHz,
  sanitizeHiResCrossfadeResampleHz,
} from '@/lib/audio/hiResCrossfadeResample';
import type { TFunction } from 'i18next';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';

interface Props {
  enabled: boolean;
  resampleHz: HiResCrossfadeResampleHz;
  onResampleHzChange: (hz: HiResCrossfadeResampleHz) => void;
  t: TFunction;
}

function labelForHz(t: TFunction, hz: HiResCrossfadeResampleHz): string {
  if (hz === 88_200) return t('settings.hiResCrossfadeResample88');
  if (hz === 96_000) return t('settings.hiResCrossfadeResample96');
  return t('settings.hiResCrossfadeResample44');
}

/** Hi-Res crossfade / AutoDJ / gapless blend-rate picker (visible when hi-res is on). */
export function HiResCrossfadeResampleBlock({
  enabled,
  resampleHz,
  onResampleHzChange,
  t,
}: Props) {
  if (!enabled) return null;

  return (
    <SettingsSubCard style={{ marginTop: '0.85rem' }}>
      <SettingsField
        label={t('settings.hiResCrossfadeResampleTitle')}
        desc={t('settings.hiResCrossfadeResampleDesc')}
        note={t('settings.hiResCrossfadeResampleWarning')}
      >
        <div className="settings-segmented">
          {HI_RES_CROSSFADE_RESAMPLE_OPTIONS.map((hz) => (
            <button
              key={hz}
              type="button"
              className={`btn ${resampleHz === hz ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => onResampleHzChange(sanitizeHiResCrossfadeResampleHz(hz))}
            >
              {labelForHz(t, hz)}
            </button>
          ))}
        </div>
      </SettingsField>
    </SettingsSubCard>
  );
}
