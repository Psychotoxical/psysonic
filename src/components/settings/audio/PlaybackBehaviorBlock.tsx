import React from 'react';
import type { TFunction } from 'i18next';
import { useAuthStore } from '../../../store/authStore';

interface Props {
  t: TFunction;
}

/**
 * Crossfade ↔ Gapless are mutually exclusive — enabling one forces the
 * other off (`setGaplessEnabled(false)` / `setCrossfadeEnabled(false)`
 * on the toggle handlers) and the inactive row dims via opacity +
 * pointerEvents:none. The crossfade-seconds slider only renders while
 * crossfade is the active mode.
 *
 * The `preservePlayNextOrder` toggle is independent of both and pinned
 * to the bottom of the block.
 */
export function PlaybackBehaviorBlock({ t }: Props) {
  const auth = useAuthStore();

  return (
    <>
      <div className="settings-toggle-row" style={auth.gaplessEnabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
        <div>
          <div style={{ fontWeight: 500 }}>
            {t('settings.crossfade')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {auth.gaplessEnabled ? t('settings.notWithGapless') : t('settings.crossfadeDesc')}
          </div>
        </div>
        <label className="toggle-switch" aria-label={t('settings.crossfade')}>
          <input type="checkbox" checked={auth.crossfadeEnabled} disabled={auth.gaplessEnabled}
            onChange={e => { auth.setGaplessEnabled(false); auth.setCrossfadeEnabled(e.target.checked); }} id="crossfade-toggle" />
          <span className="toggle-track" />
        </label>
      </div>
      {auth.crossfadeEnabled && !auth.gaplessEnabled && (
        <div style={{ paddingLeft: '1rem', marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
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

      <div className="divider" />

      <div className="settings-toggle-row" style={auth.crossfadeEnabled ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
        <div>
          <div style={{ fontWeight: 500 }}>
            {t('settings.gapless')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {auth.crossfadeEnabled ? t('settings.notWithCrossfade') : t('settings.gaplessDesc')}
          </div>
        </div>
        <label className="toggle-switch" aria-label={t('settings.gapless')}>
          <input type="checkbox" checked={auth.gaplessEnabled} disabled={auth.crossfadeEnabled}
            onChange={e => { auth.setCrossfadeEnabled(false); auth.setGaplessEnabled(e.target.checked); }} id="gapless-toggle" />
          <span className="toggle-track" />
        </label>
      </div>

      <div className="settings-toggle-row" style={{ marginTop: '0.75rem' }}>
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
    </>
  );
}
