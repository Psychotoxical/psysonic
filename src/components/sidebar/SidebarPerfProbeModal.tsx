import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { resetPerfProbeFlags, setPerfProbeFlag, type PerfProbeFlags } from '../../utils/perfFlags';

interface PerfCpu {
  app: number;
  webkit: number;
  supported: boolean;
}

interface PerfDiagRates {
  progress: number;
  waveform: number;
  home: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  perfFlags: PerfProbeFlags;
  perfCpu: PerfCpu | null;
  perfDiagRates: PerfDiagRates | null;
  hotCacheEnabled: boolean;
  setHotCacheEnabled: (v: boolean) => void;
  normalizationEngine: string;
  setNormalizationEngine: (v: 'off' | 'loudness') => void;
  loggingMode: string;
  setLoggingMode: (v: 'off' | 'normal') => void;
}

export default function SidebarPerfProbeModal({
  open, onClose, perfFlags, perfCpu, perfDiagRates,
  hotCacheEnabled, setHotCacheEnabled,
  normalizationEngine, setNormalizationEngine,
  loggingMode, setLoggingMode,
}: Props) {
  if (!open) return null;
  return createPortal(
        <div className="modal-overlay modal-overlay--perf-probe" onClick={() => onClose()} role="dialog" aria-modal="true">
          <div
            className="modal-content sidebar-perf-modal"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 560 }}
          >
            <button className="modal-close" onClick={() => onClose()}><X size={18} /></button>
            <h3 className="modal-title">Performance Probe</h3>
            <p className="sidebar-perf-modal__hint">
              Temporary runtime switches to estimate UI effect cost.
            </p>
            <label className="sidebar-perf-modal__item">
              <input
                type="checkbox"
                checked={perfFlags.showFpsOverlay}
                onChange={e => setPerfProbeFlag('showFpsOverlay', e.target.checked)}
              />
              <span>Show FPS overlay (requestAnimationFrame rate)</span>
            </label>
            <div className="sidebar-perf-modal__cpu">
              <div className="sidebar-perf-modal__cpu-title">Live CPU (approx)</div>
              {perfCpu == null ? (
                <div className="sidebar-perf-modal__cpu-row">Collecting samples…</div>
              ) : perfCpu.supported ? (
                <>
                  <div className="sidebar-perf-modal__cpu-row">psysonic: {perfCpu.app.toFixed(1)}%</div>
                  <div className="sidebar-perf-modal__cpu-row">WebKitWebProcess: {perfCpu.webkit.toFixed(1)}%</div>
                  {perfDiagRates && (
                    <>
                      <div className="sidebar-perf-modal__cpu-row">audio:progress rate: {perfDiagRates.progress.toFixed(1)}/s</div>
                      <div className="sidebar-perf-modal__cpu-row">waveform draws rate: {perfDiagRates.waveform.toFixed(1)}/s</div>
                      <div className="sidebar-perf-modal__cpu-row">Home commits rate: {perfDiagRates.home.toFixed(1)}/s</div>
                    </>
                  )}
                </>
              ) : (
                <div className="sidebar-perf-modal__cpu-row">Unavailable on this platform/build.</div>
              )}
            </div>
            <details className="sidebar-perf-modal__phase">
              <summary className="sidebar-perf-modal__phase-title">Phase 1 — Global / Shell / Network</summary>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableWaveformCanvas}
                  onChange={e => setPerfProbeFlag('disableWaveformCanvas', e.target.checked)}
                />
                <span>Disable only PlayerBar waveform (`WaveformSeek`)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disablePlayerProgressUi}
                  onChange={e => setPerfProbeFlag('disablePlayerProgressUi', e.target.checked)}
                />
                <span>Disable player live progress UI updates (time + seek/progress bindings)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMarqueeScroll}
                  onChange={e => setPerfProbeFlag('disableMarqueeScroll', e.target.checked)}
                />
                <span>Disable marquee text scrolling</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableBackdropBlur}
                  onChange={e => setPerfProbeFlag('disableBackdropBlur', e.target.checked)}
                />
                <span>Disable backdrop blur effects</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableCssAnimations}
                  onChange={e => setPerfProbeFlag('disableCssAnimations', e.target.checked)}
                />
                <span>Disable CSS animations and transitions</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableOverlayScrollbars}
                  onChange={e => setPerfProbeFlag('disableOverlayScrollbars', e.target.checked)}
                />
                <span>Disable overlay scrollbar engine (JS + rail)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableTooltipPortal}
                  onChange={e => setPerfProbeFlag('disableTooltipPortal', e.target.checked)}
                />
                <span>Disable global tooltip portal/listeners</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableQueuePanelMount}
                  onChange={e => setPerfProbeFlag('disableQueuePanelMount', e.target.checked)}
                />
                <span>Disable QueuePanel mount (desktop right column)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableBackgroundPolling}
                  onChange={e => setPerfProbeFlag('disableBackgroundPolling', e.target.checked)}
                />
                <span>Disable background polling (connection + radio metadata)</span>
              </label>
              <div className="sidebar-perf-modal__subhead">Engine/network toggles</div>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={!hotCacheEnabled}
                  onChange={e => setHotCacheEnabled(!e.target.checked)}
                />
                <span>Disable hot-cache prefetch downloads</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={normalizationEngine === 'off'}
                  onChange={e => setNormalizationEngine(e.target.checked ? 'off' : 'loudness')}
                />
                <span>Disable normalization engine (set to Off)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={loggingMode === 'off'}
                  onChange={e => setLoggingMode(e.target.checked ? 'off' : 'normal')}
                />
                <span>Set runtime logging mode to Off</span>
              </label>
            </details>
            <details className="sidebar-perf-modal__phase">
              <summary className="sidebar-perf-modal__phase-title">Phase 2 — Mainstage (Center Content)</summary>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainRouteContentMount}
                  onChange={e => setPerfProbeFlag('disableMainRouteContentMount', e.target.checked)}
                />
                <span>Disable central route content mount</span>
              </label>
              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Shared mainstage layers (multiple pages)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageStickyHeader}
                    onChange={e => setPerfProbeFlag('disableMainstageStickyHeader', e.target.checked)}
                  />
                  <span>Disable sticky headers (Tracks + Albums)</span>
                </label>
              </details>

              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Home (`/`)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageHero}
                    onChange={e => setPerfProbeFlag('disableMainstageHero', e.target.checked)}
                  />
                  <span>Disable Home hero block</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageHeroBackdrop}
                    onChange={e => setPerfProbeFlag('disableMainstageHeroBackdrop', e.target.checked)}
                  />
                  <span>Disable Hero backdrop/crossfade only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRails}
                    onChange={e => setPerfProbeFlag('disableMainstageRails', e.target.checked)}
                  />
                  <span>Disable Home rows/rails (`AlbumRow` + `SongRail`)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeAlbumRows}
                    onChange={e => setPerfProbeFlag('disableHomeAlbumRows', e.target.checked)}
                  />
                  <span>Disable Home `AlbumRow` sections only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeSongRails}
                    onChange={e => setPerfProbeFlag('disableHomeSongRails', e.target.checked)}
                  />
                  <span>Disable Home `SongRail` sections only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailArtwork}
                    onChange={e => setPerfProbeFlag('disableMainstageRailArtwork', e.target.checked)}
                  />
                  <span>Disable artwork inside Home rows/rails</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeRailArtwork}
                    onChange={e => setPerfProbeFlag('disableHomeRailArtwork', e.target.checked)}
                  />
                  <span>Disable artwork inside Home rows/rails only</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeArtworkFx}
                    onChange={e => setPerfProbeFlag('disableHomeArtworkFx', e.target.checked)}
                  />
                  <span>Keep artwork, disable Home card visual effects (hover/overlay/shadows)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableHomeArtworkClip}
                    onChange={e => setPerfProbeFlag('disableHomeArtworkClip', e.target.checked)}
                  />
                  <span>Diagnostic: flatten Home artwork clipping (no rounded corners/masks)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailInteractivity}
                    onChange={e => setPerfProbeFlag('disableMainstageRailInteractivity', e.target.checked)}
                  />
                  <span>Disable Home rail scroll/nav handlers</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageGridCards}
                    onChange={e => setPerfProbeFlag('disableMainstageGridCards', e.target.checked)}
                  />
                  <span>Disable Home discover artists chip-grid</span>
                </label>
              </details>

              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Tracks (`/tracks`)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageHero}
                    onChange={e => setPerfProbeFlag('disableMainstageHero', e.target.checked)}
                  />
                  <span>Disable Tracks hero block</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRails}
                    onChange={e => setPerfProbeFlag('disableMainstageRails', e.target.checked)}
                  />
                  <span>Disable Tracks rails (Highly Rated + Random)</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailArtwork}
                    onChange={e => setPerfProbeFlag('disableMainstageRailArtwork', e.target.checked)}
                  />
                  <span>Disable artwork inside Tracks rails</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageRailInteractivity}
                    onChange={e => setPerfProbeFlag('disableMainstageRailInteractivity', e.target.checked)}
                  />
                  <span>Disable Tracks rail scroll/nav handlers</span>
                </label>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageVirtualLists}
                    onChange={e => setPerfProbeFlag('disableMainstageVirtualLists', e.target.checked)}
                  />
                  <span>Disable Tracks virtual browse list (`VirtualSongList`)</span>
                </label>
              </details>

              <details className="sidebar-perf-modal__phase sidebar-perf-modal__phase--nested">
                <summary className="sidebar-perf-modal__phase-title">Albums (`/albums`)</summary>
                <label className="sidebar-perf-modal__item">
                  <input
                    type="checkbox"
                    checked={perfFlags.disableMainstageGridCards}
                    onChange={e => setPerfProbeFlag('disableMainstageGridCards', e.target.checked)}
                  />
                  <span>Disable Albums card grid (`AlbumCard` list)</span>
                </label>
              </details>
            </details>
            <details className="sidebar-perf-modal__phase">
              <summary className="sidebar-perf-modal__phase-title">Phase 3 — Active diagnostics (quick access)</summary>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disablePlayerProgressUi}
                  onChange={e => setPerfProbeFlag('disablePlayerProgressUi', e.target.checked)}
                />
                <span>Disable player live progress UI updates (time + seek/progress bindings)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableWaveformCanvas}
                  onChange={e => setPerfProbeFlag('disableWaveformCanvas', e.target.checked)}
                />
                <span>Disable only PlayerBar waveform (`WaveformSeek`)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableHomeRailArtwork}
                  onChange={e => setPerfProbeFlag('disableHomeRailArtwork', e.target.checked)}
                />
                <span>Disable artwork inside Home rows/rails only</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainstageRailArtwork}
                  onChange={e => setPerfProbeFlag('disableMainstageRailArtwork', e.target.checked)}
                />
                <span>Disable artwork inside Home rows/rails</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainstageRails}
                  onChange={e => setPerfProbeFlag('disableMainstageRails', e.target.checked)}
                />
                <span>Disable Home rows/rails (`AlbumRow` + `SongRail`)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableMainstageHeroBackdrop}
                  onChange={e => setPerfProbeFlag('disableMainstageHeroBackdrop', e.target.checked)}
                />
                <span>Disable Hero backdrop/crossfade only</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableHomeArtworkFx}
                  onChange={e => setPerfProbeFlag('disableHomeArtworkFx', e.target.checked)}
                />
                <span>Keep artwork, disable Home card visual effects (hover/overlay/shadows)</span>
              </label>
              <label className="sidebar-perf-modal__item">
                <input
                  type="checkbox"
                  checked={perfFlags.disableHomeArtworkClip}
                  onChange={e => setPerfProbeFlag('disableHomeArtworkClip', e.target.checked)}
                />
                <span>Diagnostic: flatten Home artwork clipping (no rounded corners/masks)</span>
              </label>
            </details>
            <div className="sidebar-perf-modal__actions">
              <button type="button" className="btn btn-ghost" onClick={() => resetPerfProbeFlags()}>
                Reset
              </button>
              <button type="button" className="btn btn-primary" onClick={() => onClose()}>
                Close
              </button>
            </div>
          </div>
        </div>,
    document.body,
  );
}
