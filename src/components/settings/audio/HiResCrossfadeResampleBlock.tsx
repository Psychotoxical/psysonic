import {
  HI_RES_CROSSFADE_RESAMPLE_OPTIONS,
  type HiResCrossfadeResampleHz,
  sanitizeHiResCrossfadeResampleHz,
} from '../../../utils/audio/hiResCrossfadeResample';
import type { TFunction } from 'i18next';
import { SettingsGroup } from '../SettingsGroup';

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
    <SettingsGroup>
      <p className="settings-row-label" style={{ marginBottom: '0.5rem' }}>
        {t('settings.hiResCrossfadeResampleTitle')}
      </p>
      <p className="settings-row-desc" style={{ marginBottom: '0.75rem' }}>
        {t('settings.hiResCrossfadeResampleDesc')}
      </p>
      <div className="settings-segmented" style={{ marginBottom: '0.75rem' }}>
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
      <p className="settings-row-desc" role="note" style={{ marginBottom: 0, opacity: 0.85 }}>
        {t('settings.hiResCrossfadeResampleWarning')}
      </p>
    </SettingsGroup>
  );
}
