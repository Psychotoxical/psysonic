import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AudioLines, Music2, Play, RotateCcw, Sliders, Waves } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB, TRACK_PREVIEW_LOCATIONS } from '../../store/authStoreDefaults';
import type { TrackPreviewLocation } from '../../store/authStoreTypes';
import CustomSelect from '../CustomSelect';
import Equalizer from '../Equalizer';
import SettingsSubSection from '../SettingsSubSection';
import { LoudnessLufsButtonGroup } from './LoudnessLufsButtonGroup';
import { IS_MACOS } from '../../utils/platform';
import { buildAudioDeviceSelectOptions, sortAudioDeviceIds } from '../../utils/audioDeviceLabels';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/loudnessPreAnalysisSlider';
import { showToast } from '../../utils/toast';

export function AudioTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const [audioDevices, setAudioDevices] = useState<string[]>([]);
  const [osDefaultAudioDeviceId, setOsDefaultAudioDeviceId] = useState<string | null>(null);
  const [deviceSwitching, setDeviceSwitching] = useState(false);
  const [devicesLoading, setDevicesLoading] = useState(false);

  const preAnalysisEffectiveDb = useMemo(
    () => effectiveLoudnessPreAnalysisAttenuationDb(
      auth.loudnessPreAnalysisAttenuationDb,
      auth.loudnessTargetLufs,
    ),
    [auth.loudnessPreAnalysisAttenuationDb, auth.loudnessTargetLufs],
  );

  const refreshAudioDevices = useCallback((opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) setDevicesLoading(true);
    const listP = invoke<string[]>('audio_list_devices').catch((e) => {
      console.error(e);
      showToast(t('settings.audioOutputDeviceListError'), 5000, 'error');
      return [] as string[];
    });
    const defP = invoke<string | null>('audio_default_output_device_name').catch(() => null);
    Promise.all([listP, defP])
      .then(async ([devices, osDefault]) => {
        let canon: string | null = null;
        try {
          canon = await invoke<string | null>('audio_canonicalize_selected_device');
          if (canon) useAuthStore.getState().setAudioOutputDevice(canon);
        } catch {
          /* ignore */
        }
        const finalList = canon
          ? await invoke<string[]>('audio_list_devices').catch(() => devices)
          : devices;
        const defId = osDefault ?? null;
        setAudioDevices(sortAudioDeviceIds(finalList, defId));
        setOsDefaultAudioDeviceId(defId);
      })
      .finally(() => {
        if (!silent) setDevicesLoading(false);
      });
  }, [t]);

  // Load available audio output devices on mount.
  // Skipped on macOS — the stream is pinned to the system default (see
  // audioOutputDeviceMacNotice) so there is no picker to populate.
  useEffect(() => {
    if (IS_MACOS) return;
    refreshAudioDevices();
  }, [refreshAudioDevices]);

  // Keep device list + "current system output" mark in sync when the backend reopens the stream.
  useEffect(() => {
    if (IS_MACOS) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      for (const ev of ['audio:device-changed', 'audio:device-reset'] as const) {
        const u = await listen(ev, () => {
          if (!cancelled) refreshAudioDevices({ silent: true });
        });
        if (cancelled) {
          u();
          return;
        }
        unlisteners.push(u);
      }
    })();
    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, [refreshAudioDevices]);

  return (
    <>
      {/* Audio Output Device */}
      <SettingsSubSection
        title={t('settings.audioOutputDevice')}
        icon={<AudioLines size={16} />}
      >
        <div className="settings-card">
          {IS_MACOS ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55 }}>
              {t('settings.audioOutputDeviceMacNotice')}
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                {t('settings.audioOutputDeviceDesc')}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <CustomSelect
                  style={{ flex: 1 }}
                  value={auth.audioOutputDevice ?? ''}
                  disabled={deviceSwitching || devicesLoading}
                  onChange={async (val) => {
                    const device = val || null;
                    setDeviceSwitching(true);
                    try {
                      await invoke('audio_set_device', { deviceName: device });
                      auth.setAudioOutputDevice(device);
                    } catch { /* device open failed — don't persist */ }
                    setDeviceSwitching(false);
                  }}
                  options={buildAudioDeviceSelectOptions(
                    audioDevices,
                    t('settings.audioOutputDeviceDefault'),
                    osDefaultAudioDeviceId,
                    t('settings.audioOutputDeviceOsDefaultNow'),
                    auth.audioOutputDevice,
                    t('settings.audioOutputDeviceNotInCurrentList'),
                  )}
                />
                <button
                  className="icon-btn"
                  onClick={() => refreshAudioDevices()}
                  disabled={devicesLoading || deviceSwitching}
                  data-tooltip={t('settings.audioOutputDeviceRefresh')}
                >
                  <RotateCcw size={15} className={devicesLoading ? 'spin' : ''} />
                </button>
              </div>
            </>
          )}
        </div>
      </SettingsSubSection>

      {/* Native Hi-Res Playback */}
      <SettingsSubSection
        title={t('settings.hiResTitle')}
        icon={<Waves size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.hiResEnabled')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.hiResDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.hiResEnabled')}>
              <input
                type="checkbox"
                checked={auth.enableHiRes}
                onChange={e => auth.setEnableHiRes(e.target.checked)}
                id="hires-enabled-toggle"
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </SettingsSubSection>

      {/* Equalizer */}
      <SettingsSubSection
        title={t('settings.eqTitle')}
        icon={<Sliders size={16} />}
      >
        <div className="settings-card">
          <Equalizer />
        </div>
      </SettingsSubSection>

      {/* Replay Gain + Crossfade + Gapless */}
      <SettingsSubSection
        title={t('settings.playbackTitle')}
        icon={<Music2 size={16} />}
      >
        <div className="settings-card">
          {/* Normalization */}
          <div style={{ marginBottom: '0.6rem' }}>
            <div style={{ fontWeight: 500 }}>{t('settings.normalization', { defaultValue: 'Normalization' })}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.normalizationDesc')}
            </div>
          </div>
          <div className="settings-segmented" style={{ marginBottom: auth.normalizationEngine === 'off' ? 0 : '0.85rem' }}>
            <button
              type="button"
              className={`btn ${auth.normalizationEngine === 'off' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => {
                auth.setReplayGainEnabled(false);
                auth.setNormalizationEngine('off');
              }}
            >
              {t('settings.normalizationOff')}
            </button>
            <button
              type="button"
              className={`btn ${auth.normalizationEngine === 'replaygain' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => {
                auth.setReplayGainEnabled(true);
                auth.setNormalizationEngine('replaygain');
              }}
            >
              {t('settings.normalizationReplayGain')}
            </button>
            <button
              type="button"
              className={`btn ${auth.normalizationEngine === 'loudness' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => {
                auth.setReplayGainEnabled(false);
                if (auth.normalizationEngine !== 'loudness') auth.setLoudnessTargetLufs(-12);
                auth.setNormalizationEngine('loudness');
              }}
            >
              {t('settings.normalizationLufs')}
            </button>
          </div>
          {auth.normalizationEngine === 'replaygain' && (
            <div className="settings-norm-block">
              <div className="settings-norm-field">
                <div className="settings-norm-row">
                  <span className="settings-norm-label">{t('settings.replayGainMode')}</span>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <button
                      className={`btn ${auth.replayGainMode === 'auto' ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '4px 14px' }}
                      onClick={() => auth.setReplayGainMode('auto')}
                    >
                      {t('settings.replayGainAuto')}
                    </button>
                    <button
                      className={`btn ${auth.replayGainMode === 'track' ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '4px 14px' }}
                      onClick={() => auth.setReplayGainMode('track')}
                    >
                      {t('settings.replayGainTrack')}
                    </button>
                    <button
                      className={`btn ${auth.replayGainMode === 'album' ? 'btn-primary' : 'btn-ghost'}`}
                      style={{ fontSize: 12, padding: '4px 14px' }}
                      onClick={() => auth.setReplayGainMode('album')}
                    >
                      {t('settings.replayGainAlbum')}
                    </button>
                  </div>
                </div>
                {auth.replayGainMode === 'auto' && (
                  <div className="settings-norm-help">{t('settings.replayGainAutoDesc')}</div>
                )}
              </div>
              <div className="settings-norm-field">
                <div className="settings-norm-row">
                  <span className="settings-norm-label">{t('settings.replayGainPreGain')}</span>
                  <input
                    type="range" min={0} max={6} step={0.5}
                    value={auth.replayGainPreGainDb}
                    onChange={e => auth.setReplayGainPreGainDb(Number(e.target.value))}
                  />
                  <span className="settings-norm-value">
                    {auth.replayGainPreGainDb > 0 ? `+${auth.replayGainPreGainDb}` : auth.replayGainPreGainDb} dB
                  </span>
                </div>
                <div className="settings-norm-help">{t('settings.replayGainPreGainDesc')}</div>
              </div>
              <div className="settings-norm-field">
                <div className="settings-norm-row">
                  <span className="settings-norm-label">{t('settings.replayGainFallback')}</span>
                  <input
                    type="range" min={-6} max={0} step={0.5}
                    value={auth.replayGainFallbackDb}
                    onChange={e => auth.setReplayGainFallbackDb(Number(e.target.value))}
                  />
                  <span className="settings-norm-value">
                    {auth.replayGainFallbackDb > 0 ? `+${auth.replayGainFallbackDb}` : auth.replayGainFallbackDb} dB
                  </span>
                </div>
                <div className="settings-norm-help">{t('settings.replayGainFallbackDesc')}</div>
              </div>
            </div>
          )}
          {auth.normalizationEngine === 'loudness' && (
            <div className="settings-norm-block">
              <div className="settings-norm-field">
                <div className="settings-norm-row">
                  <span className="settings-norm-label">{t('settings.loudnessTargetLufs')}</span>
                  <LoudnessLufsButtonGroup value={auth.loudnessTargetLufs} onSelect={auth.setLoudnessTargetLufs} />
                </div>
                <div className="settings-norm-help">{t('settings.loudnessTargetLufsDesc')}</div>
              </div>
              <div className="settings-norm-field">
                <div className="settings-norm-row">
                  <span className="settings-norm-label">{t('settings.loudnessPreAnalysisAttenuation')}</span>
                  <input
                    type="range"
                    min={-24}
                    max={0}
                    step={0.5}
                    value={auth.loudnessPreAnalysisAttenuationDb}
                    onChange={e => auth.setLoudnessPreAnalysisAttenuationDb(Number(e.target.value))}
                  />
                  <span className="settings-norm-value">
                    {preAnalysisEffectiveDb} dB
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ flexShrink: 0 }}
                    disabled={
                      auth.loudnessPreAnalysisAttenuationDb === DEFAULT_LOUDNESS_PRE_ANALYSIS_ATTENUATION_DB
                    }
                    onClick={() => auth.resetLoudnessPreAnalysisAttenuationDbDefault()}
                    data-tooltip={t('settings.loudnessPreAnalysisAttenuationReset')}
                    aria-label={t('settings.loudnessPreAnalysisAttenuationReset')}
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
                <div className="settings-norm-help">
                  {t('settings.loudnessPreAnalysisAttenuationDesc')}{' '}
                  {t('settings.loudnessPreAnalysisAttenuationRef', {
                    ref: auth.loudnessPreAnalysisAttenuationDb,
                    eff: preAnalysisEffectiveDb,
                    tgt: auth.loudnessTargetLufs,
                  })}
                </div>
              </div>
              <div className="settings-norm-note">{t('settings.loudnessFirstPlayNote')}</div>
            </div>
          )}

          <div className="divider" />

          {/* Crossfade */}
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

          {/* Gapless */}
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
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.trackPreviewsTitle')}
        icon={<Play size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>
                {t('settings.trackPreviewsToggle')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('settings.trackPreviewsDesc')}
              </div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.trackPreviewsToggle')}>
              <input type="checkbox" checked={auth.trackPreviewsEnabled}
                onChange={e => auth.setTrackPreviewsEnabled(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>

          {auth.trackPreviewsEnabled && (
            <>
              <div className="divider" />
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  {t('settings.trackPreviewLocationsTitle')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  {t('settings.trackPreviewLocationsDesc')}
                </div>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}>
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
              </div>

              <div className="divider" />
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  {t('settings.trackPreviewStart')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {t('settings.trackPreviewStartDesc')}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input
                    type="range"
                    min={0}
                    max={0.9}
                    step={0.01}
                    value={auth.trackPreviewStartRatio}
                    onChange={e => auth.setTrackPreviewStartRatio(parseFloat(e.target.value))}
                    style={{ flex: 1, minWidth: 80, maxWidth: 240 }}
                    aria-label={t('settings.trackPreviewStart')}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 44 }}>
                    {Math.round(auth.trackPreviewStartRatio * 100)}%
                  </span>
                </div>
              </div>

              <div className="divider" />
              <div>
                <div style={{ fontWeight: 500, marginBottom: 4 }}>
                  {t('settings.trackPreviewDuration')}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {t('settings.trackPreviewDurationDesc')}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <input
                    type="range"
                    min={5}
                    max={60}
                    step={1}
                    value={auth.trackPreviewDurationSec}
                    onChange={e => auth.setTrackPreviewDurationSec(parseInt(e.target.value, 10))}
                    style={{ flex: 1, minWidth: 80, maxWidth: 240 }}
                    aria-label={t('settings.trackPreviewDuration')}
                  />
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 44 }}>
                    {t('settings.trackPreviewDurationSecs', { n: auth.trackPreviewDurationSec })}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </SettingsSubSection>
    </>
  );
}
