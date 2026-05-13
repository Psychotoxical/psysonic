import React from 'react';
import { ChevronDown, FolderOpen, HardDrive, Music, Waves } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Track } from '../../store/playerStoreTypes';
import type { LoudnessLufsPreset, NormalizationEngine } from '../../store/authStoreTypes';
import type { PlaybackSourceKind } from '../../utils/resolvePlaybackUrl';
import {
  formatQueueReplayGainParts,
  renderStars,
} from '../../utils/queuePanelHelpers';
import { loudnessGainPlaceholderUntilCacheDb } from '../../utils/loudnessPlaceholder';
import { effectiveLoudnessPreAnalysisAttenuationDb } from '../../utils/loudnessPreAnalysisSlider';
import { QueueLufsTargetMenu } from './QueueLufsTargetMenu';

interface Props {
  currentTrack: Track;
  currentCoverSrc: string;
  userRatingOverrides: Record<string, number>;
  orbitAttributionLabel: (trackId: string) => string | null;
  navigate: (to: string) => void;
  playbackSource: PlaybackSourceKind | null;
  normalizationEngine: NormalizationEngine;
  normalizationEngineLive: 'off' | 'replaygain' | 'loudness';
  normalizationNowDb: number | null;
  normalizationTargetLufs: number | null;
  authLoudnessTargetLufs: LoudnessLufsPreset;
  loudnessPreAnalysisAttenuationDb: number;
  expandReplayGain: boolean;
  setExpandReplayGain: (v: boolean) => void;
  reanalyzeLoudnessForTrack: (id: string) => void | Promise<void>;
  setLoudnessTargetLufs: (v: LoudnessLufsPreset) => void;
  lufsTgtOpen: boolean;
  setLufsTgtOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  lufsTgtBtnRef: React.RefObject<HTMLButtonElement | null>;
  lufsTgtMenuRef: React.RefObject<HTMLDivElement | null>;
  lufsTgtPopStyle: React.CSSProperties;
  t: TFunction;
}

export function QueueCurrentTrack({
  currentTrack, currentCoverSrc, userRatingOverrides, orbitAttributionLabel,
  navigate, playbackSource, normalizationEngine, normalizationEngineLive,
  normalizationNowDb, normalizationTargetLufs, authLoudnessTargetLufs,
  loudnessPreAnalysisAttenuationDb, expandReplayGain, setExpandReplayGain,
  reanalyzeLoudnessForTrack, setLoudnessTargetLufs, lufsTgtOpen, setLufsTgtOpen,
  lufsTgtBtnRef, lufsTgtMenuRef, lufsTgtPopStyle, t,
}: Props) {
  return (
    <div className="queue-current-track">
      {(() => {
        const baseParts = [
          currentTrack.suffix?.toUpperCase(),
          currentTrack.bitRate ? `${currentTrack.bitRate} kbps` : undefined,
          (() => {
            const bd = currentTrack.bitDepth;
            const sr = currentTrack.samplingRate ? `${currentTrack.samplingRate / 1000} kHz` : '';
            if (bd && sr) return `${bd}/${sr}`;
            if (bd) return `${bd}-bit`;
            if (sr) return sr;
            return undefined;
          })(),
        ].filter(Boolean) as string[];
        const rgParts = formatQueueReplayGainParts(currentTrack, t);
        const baseLine = baseParts.join(' · ');
        const rgLine = rgParts.join(' · ');
        const isLoudnessActive = normalizationEngine === 'loudness' || normalizationEngineLive === 'loudness';
        const liveGainLabel = (() => {
          if (normalizationNowDb != null && Number.isFinite(normalizationNowDb)) {
            return `${normalizationNowDb >= 0 ? '+' : ''}${normalizationNowDb.toFixed(2)} dB`;
          }
          if (isLoudnessActive && Number.isFinite(loudnessPreAnalysisAttenuationDb)) {
            const preEff = effectiveLoudnessPreAnalysisAttenuationDb(
              loudnessPreAnalysisAttenuationDb,
              authLoudnessTargetLufs,
            );
            const ph = loudnessGainPlaceholderUntilCacheDb(
              authLoudnessTargetLufs,
              preEff,
            );
            return `${ph >= 0 ? '+' : ''}${ph.toFixed(2)} dB`;
          }
          return '—';
        })();
        const tgtNum = normalizationTargetLufs ?? authLoudnessTargetLufs;
        const targetLabel = `${tgtNum} LUFS`;
        if (!baseLine && !rgLine && !playbackSource) return null;
        const showRgLine = !isLoudnessActive && expandReplayGain && !!rgLine;
        const showLufsLine = isLoudnessActive && expandReplayGain;
        return (
          <div className={`queue-current-tech${showRgLine ? ' queue-current-tech--two-line' : ''}`}>
            <div className="queue-current-tech-stack">
              <div className="queue-current-tech-row">
                {playbackSource && (
                  <span
                    className="queue-current-tech-source"
                    data-tooltip={
                      playbackSource === 'offline'
                        ? t('queue.sourceOffline')
                        : playbackSource === 'hot'
                          ? t('queue.sourceHot')
                          : t('queue.sourceStream')
                    }
                    aria-hidden
                  >
                    {playbackSource === 'offline' && <FolderOpen size={11} strokeWidth={2.25} />}
                    {playbackSource === 'hot' && <HardDrive size={11} strokeWidth={2.25} />}
                    {playbackSource === 'stream' && <Waves size={11} strokeWidth={2.25} />}
                  </span>
                )}
                {baseLine && <span className="queue-current-tech-main">{baseLine}</span>}
                {!isLoudnessActive && rgLine && (
                  <button
                    type="button"
                    className={`queue-current-tech-rg-badge${showRgLine ? ' queue-current-tech-rg-badge--open' : ''}`}
                    data-tooltip={`${t('queue.replayGain')} · ${rgLine}`}
                    aria-expanded={showRgLine}
                    aria-label={t('queue.replayGain')}
                    onClick={() => setExpandReplayGain(!expandReplayGain)}
                  >
                    RG
                    <ChevronDown size={9} strokeWidth={2.5} />
                  </button>
                )}
                {isLoudnessActive && (
                  <button
                    type="button"
                    className={`queue-current-tech-rg-badge${showLufsLine ? ' queue-current-tech-rg-badge--open' : ''}`}
                    data-tooltip={`LUFS · ${liveGainLabel} · TGT · ${targetLabel}`}
                    aria-expanded={showLufsLine}
                    aria-label="LUFS"
                    onClick={() => setExpandReplayGain(!expandReplayGain)}
                  >
                    LUFS
                    <ChevronDown size={9} strokeWidth={2.5} />
                  </button>
                )}
              </div>
              {showRgLine && (
                <span className="queue-current-tech-rg">
                  <span className="queue-current-tech-rg-label">{t('queue.replayGain')}</span>
                  {' · '}{rgLine}
                </span>
              )}
              {showLufsLine && (
                <span className="queue-current-tech-rg">
                  <span className="queue-current-tech-rg-label">Loudness</span>
                  {' · '}
                  <button
                    type="button"
                    className="queue-current-tech-metric queue-current-tech-metric--lufs-reanalyze"
                    onClick={e => {
                      e.stopPropagation();
                      setLufsTgtOpen(false);
                      void reanalyzeLoudnessForTrack(currentTrack.id);
                    }}
                    data-tooltip={t('queue.clearCachedLoudnessWaveform')}
                    aria-label={t('queue.clearCachedLoudnessWaveform')}
                  >
                    {liveGainLabel}
                  </button>
                  {' · '}
                  <span className="queue-current-tech-rg-label">TGT</span>
                  {' · '}
                  <button
                    type="button"
                    ref={lufsTgtBtnRef}
                    className="queue-current-tech-metric"
                    onClick={e => {
                      e.stopPropagation();
                      setLufsTgtOpen(v => !v);
                    }}
                    data-tooltip="Change target integrated loudness"
                    aria-haspopup="listbox"
                    aria-expanded={lufsTgtOpen}
                  >
                    {targetLabel}
                  </button>
                  {lufsTgtOpen && (
                    <QueueLufsTargetMenu
                      menuRef={lufsTgtMenuRef}
                      popStyle={lufsTgtPopStyle}
                      authLoudnessTargetLufs={authLoudnessTargetLufs}
                      setLoudnessTargetLufs={setLoudnessTargetLufs}
                      onClose={() => setLufsTgtOpen(false)}
                    />
                  )}
                </span>
              )}
            </div>
          </div>
        );
      })()}
      <div className="queue-current-track-body">
        <div className="queue-current-cover">
          {currentTrack.coverArt ? (
            <img src={currentCoverSrc} alt="" loading="eager" />
          ) : (
            <div className="fallback"><Music size={32} /></div>
          )}
        </div>
        <div className="queue-current-info">
          <h3 className="truncate">{currentTrack.title}</h3>
          <div
            className={`queue-current-sub truncate${currentTrack.artistId ? ' is-link' : ''}`}
            onClick={() => currentTrack.artistId && navigate(`/artist/${currentTrack.artistId}`)}
          >{currentTrack.artist}</div>
          <div
            className={`queue-current-sub truncate${currentTrack.albumId ? ' is-link' : ''}`}
            onClick={() => currentTrack.albumId && navigate(`/album/${currentTrack.albumId}`)}
          >{currentTrack.album}</div>
          {currentTrack.year && (
            <div className="queue-current-sub">{currentTrack.year}</div>
          )}
          {(() => {
            const label = orbitAttributionLabel(currentTrack.id);
            return label ? <div className="queue-current-sub queue-current-attribution">{label}</div> : null;
          })()}
          {renderStars(userRatingOverrides[currentTrack.id] ?? currentTrack.userRating)}
        </div>
      </div>
    </div>
  );
}
