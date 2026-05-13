import { setPerfProbeFlag, type PerfProbeFlags } from '../../utils/perfFlags';

export default function SidebarPerfProbePhase2({ perfFlags }: { perfFlags: PerfProbeFlags }) {
  return (
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
  );
}
