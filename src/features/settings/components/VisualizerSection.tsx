import type { TFunction } from 'i18next';
import { AudioLines } from 'lucide-react';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsSubCard, SettingsField, SettingsValue } from '@/features/settings/components/SettingsSubCard';
import { SettingsSegmented, type SegmentedOption } from '@/features/settings/components/SettingsSegmented';
import { useVisualizerStore, VISUALIZER_FPS_OPTIONS, MAX_SENSITIVITY, MIN_SENSITIVITY } from '@/features/visualizer';
import type { VisualizerColorSource, VisualizerMode } from '@/features/visualizer';

interface Props {
  t: TFunction;
}

/**
 * Visualizer preferences. The master toggle also controls cost: with it off no
 * surface mounts, so the audio engine never starts its FFT task at all.
 */
export function VisualizerSection({ t }: Props) {
  const {
    enabledNowPlaying, enabledFullscreen,
    mode, sensitivity, responsiveness, fps, showPeaks, colorSource,
    setSurfaceEnabled, setMode, setSensitivity, setResponsiveness, setFps,
    setShowPeaks, setColorSource,
  } = useVisualizerStore();

  // The settings below apply to every surface, so one switched-on surface is
  // enough to make them worth showing.
  const anySurfaceEnabled = enabledNowPlaying || enabledFullscreen;

  const modes: SegmentedOption<VisualizerMode>[] = [
    { id: 'bars', label: t('visualizer.modeBars') },
    { id: 'scope', label: t('visualizer.modeScope') },
    { id: 'radial', label: t('visualizer.modeRadial') },
    { id: 'stereo', label: t('visualizer.modeStereo') },
  ];

  const colorSources: SegmentedOption<VisualizerColorSource>[] = [
    { id: 'album', label: t('visualizer.settings.colorSourceAlbum') },
    { id: 'theme', label: t('visualizer.settings.colorSourceTheme') },
  ];

  // SettingsSegmented keys on strings, so the rate round-trips through one.
  const rates: SegmentedOption<string>[] = VISUALIZER_FPS_OPTIONS.map(rate => ({
    id: String(rate),
    label: `${rate} fps`,
  }));

  return (
    <SettingsSubSection
      title={t('visualizer.settings.section')}
      icon={<AudioLines size={16} />}
    >
      <div className="settings-card">
        <SettingsGroup>
          <div className="settings-hint settings-hint-info" style={{ marginBottom: '0.75rem' }}>
            {t('visualizer.settings.description')}
          </div>

          <SettingsToggle
            label={t('visualizer.settings.enableNowPlaying')}
            desc={t('visualizer.settings.enableNowPlayingHint')}
            checked={enabledNowPlaying}
            onChange={v => setSurfaceEnabled('nowPlaying', v)}
            searchText={`${t('visualizer.settings.section')} ${t('visualizer.settings.enableNowPlaying')}`}
          />

          <SettingsToggle
            label={t('visualizer.settings.enableFullscreen')}
            desc={t('visualizer.settings.enableFullscreenHint')}
            checked={enabledFullscreen}
            onChange={v => setSurfaceEnabled('fullscreen', v)}
            searchText={`${t('visualizer.settings.section')} ${t('visualizer.settings.enableFullscreen')}`}
          />

          {anySurfaceEnabled && (
            <>
              {/* Two sub-cards, not one per control: what the visualizer looks
                  like, then what it costs to run. */}
              <SettingsSubCard>
                <SettingsField label={t('visualizer.settings.mode')} row>
                  <SettingsSegmented
                    options={modes}
                    value={mode}
                    onChange={setMode}
                    ariaLabel={t('visualizer.settings.mode')}
                    className="settings-segmented-auto"
                  />
                </SettingsField>
                <SettingsField
                  label={t('visualizer.settings.colorSource')}
                  desc={t('visualizer.settings.colorSourceHint')}
                  row
                >
                  <SettingsSegmented
                    options={colorSources}
                    value={colorSource}
                    onChange={setColorSource}
                    ariaLabel={t('visualizer.settings.colorSource')}
                  />
                </SettingsField>
                <SettingsToggle
                  label={t('visualizer.settings.peaks')}
                  desc={t('visualizer.settings.peaksHint')}
                  checked={showPeaks}
                  onChange={setShowPeaks}
                />
              </SettingsSubCard>

              <SettingsSubCard>
                <SettingsField
                  label={t('visualizer.settings.sensitivity')}
                  desc={t('visualizer.settings.sensitivityHint')}
                  row
                >
                  <input
                    id="visualizer-sensitivity"
                    type="range"
                    min={MIN_SENSITIVITY}
                    max={MAX_SENSITIVITY}
                    step={0.1}
                    value={sensitivity}
                    onChange={e => setSensitivity(Number(e.target.value))}
                    aria-label={t('visualizer.settings.sensitivity')}
                  />
                  <SettingsValue>{sensitivity.toFixed(1)}×</SettingsValue>
                </SettingsField>
                <SettingsField
                  label={t('visualizer.settings.responsiveness')}
                  desc={t('visualizer.settings.responsivenessHint')}
                  row
                >
                  <input
                    id="visualizer-responsiveness"
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={responsiveness}
                    onChange={e => setResponsiveness(Number(e.target.value))}
                    aria-label={t('visualizer.settings.responsiveness')}
                  />
                  <SettingsValue>{Math.round(responsiveness * 100)}%</SettingsValue>
                </SettingsField>
                <SettingsField
                  label={t('visualizer.settings.frameRate')}
                  desc={t('visualizer.settings.frameRateHint')}
                  row
                >
                  <SettingsSegmented
                    options={rates}
                    value={String(fps)}
                    onChange={id => setFps(Number(id))}
                    ariaLabel={t('visualizer.settings.frameRate')}
                  />
                </SettingsField>
              </SettingsSubCard>

              <div className="settings-hint" style={{ marginTop: '0.6rem' }}>
                {t('visualizer.settings.radioNote')}
              </div>
            </>
          )}
        </SettingsGroup>
      </div>
    </SettingsSubSection>
  );
}
