import { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AudioLines, Contrast, Disc3, Maximize2, Minimize2, Waves } from 'lucide-react';
import VisualizerCanvas from '@/features/visualizer/components/VisualizerCanvas';
import { useVisualizerCoverArt } from '@/features/visualizer/hooks/useVisualizerCoverArt';
import {
  useVisualizerStore,
  type VisualizerSurface,
} from '@/features/visualizer/store/visualizerStore';

interface VisualizerPanelProps {
  /** Which mount point this is — expansion is exclusive across surfaces. */
  surface: VisualizerSurface;
  /** Extra class for the inline (non-expanded) shell. */
  className?: string;
}

/**
 * A visualizer with its chrome: mode toggle and an expand control that lifts
 * the canvas into a full-window overlay stopping just above the player bar, so
 * transport controls stay reachable while the visuals take the screen.
 *
 * Only one surface can be expanded at a time (the store holds a single
 * `expandedSurface`), so expanding from Now Playing while the fullscreen player
 * also has a panel mounted can't stack two overlays.
 */
export default function VisualizerPanel({
  surface,
  className,
}: VisualizerPanelProps): React.ReactElement | null {
  const { t } = useTranslation();
  const enabled = useVisualizerStore(s => s.enabled);
  const mode = useVisualizerStore(s => s.mode);
  const cycleMode = useVisualizerStore(s => s.cycleMode);
  const expandedSurface = useVisualizerStore(s => s.expandedSurface);
  const toggleExpanded = useVisualizerStore(s => s.toggleExpanded);
  const setExpandedSurface = useVisualizerStore(s => s.setExpandedSurface);
  const { artUrl, artKey } = useVisualizerCoverArt();

  const isExpanded = expandedSurface === surface;

  const collapse = useCallback(() => setExpandedSurface(null), [setExpandedSurface]);
  const onExpandClick = useCallback(() => toggleExpanded(surface), [toggleExpanded, surface]);

  // Escape collapses, matching every other full-window surface in the app.
  useEffect(() => {
    if (!isExpanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        collapse();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isExpanded, collapse]);

  // A disabled visualizer must not leave an overlay pinned open.
  useEffect(() => {
    if (!enabled && isExpanded) collapse();
  }, [enabled, isExpanded, collapse]);

  if (!enabled) return null;

  const modeLabel = {
    bars: t('visualizer.modeBars', 'Spectrum'),
    scope: t('visualizer.modeScope', 'Oscilloscope'),
    radial: t('visualizer.modeRadial', 'Radial scope'),
    stereo: t('visualizer.modeStereo', 'Stereo field'),
  }[mode];

  const ModeIcon = { bars: AudioLines, scope: Waves, radial: Disc3, stereo: Contrast }[mode];

  const controls = (
    <div className="psy-viz-controls">
      <button
        type="button"
        className="psy-viz-btn"
        onClick={cycleMode}
        title={t('visualizer.switchMode', 'Switch visualizer mode')}
        aria-label={t('visualizer.switchMode', 'Switch visualizer mode')}
      >
        <ModeIcon size={15} />
        <span className="psy-viz-btn-label">{modeLabel}</span>
      </button>
      <button
        type="button"
        className="psy-viz-btn"
        onClick={isExpanded ? collapse : onExpandClick}
        title={isExpanded
          ? t('visualizer.collapse', 'Exit full window')
          : t('visualizer.expand', 'Fill the window')}
        aria-label={isExpanded
          ? t('visualizer.collapse', 'Exit full window')
          : t('visualizer.expand', 'Fill the window')}
      >
        {isExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
    </div>
  );

  if (isExpanded) {
    // Portalled to <body> so the overlay escapes any transformed/clipped
    // ancestor (the Now Playing card grid, the fullscreen player's stacking
    // context) instead of being cropped inside it.
    return createPortal(
      <div
        className="psy-viz-overlay"
        data-surface={surface}
        data-mode={mode}
        role="region"
        aria-label={t('visualizer.title', 'Visualizer')}
      >
        <VisualizerCanvas artUrl={artUrl} artKey={artKey} className="psy-viz-canvas-full" />
        {controls}
      </div>,
      document.body,
    );
  }

  return (
    <div
      className={className ? `psy-viz-panel ${className}` : 'psy-viz-panel'}
      data-mode={mode}
    >
      <VisualizerCanvas artUrl={artUrl} artKey={artKey} />
      {controls}
    </div>
  );
}
