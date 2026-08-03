import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AudioLines, Contrast, Disc3, Maximize2, Minimize2, Waves } from 'lucide-react';
import VisualizerCanvas from '@/features/visualizer/components/VisualizerCanvas';
import { useVisualizerCoverArt } from '@/features/visualizer/hooks/useVisualizerCoverArt';
import { useWindowVisibility } from '@/lib/hooks/useWindowVisibility';
import {
  TRANSIENT_UI_OPEN_EVENT,
  requestTransientUiClose,
} from '@/lib/dom/transientUi';
import {
  useVisualizerStore,
  type VisualizerSurface,
} from '@/features/visualizer/store/visualizerStore';

interface VisualizerPanelProps {
  /** Which mount point this is — expansion is exclusive across surfaces. */
  surface: VisualizerSurface;
  /** Extra class for the inline (non-expanded) shell. */
  className?: string;
  /** Pause the feed while this surface is covered by another app surface. */
  paused?: boolean;
  /** Optional palette-art override for surfaces without a normal track. */
  artUrl?: string;
  artKey?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableDescendants(root: ParentNode | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter(node => {
      for (let current: HTMLElement | null = node; current; current = current.parentElement) {
        if (
          current.hidden
          || current.hasAttribute('inert')
          || current.getAttribute('aria-hidden') === 'true'
        ) return false;
        const style = window.getComputedStyle(current);
        if (
          style.display === 'none'
          || style.visibility === 'hidden'
          || style.visibility === 'collapse'
        ) return false;
      }
      return true;
    });
}

interface HiddenBranchSnapshot {
  node: HTMLElement;
  ariaHidden: string | null;
  inert: string | null;
}

/**
 * Hide only branches that sit behind the overlay. Ancestors of the overlay or
 * exposed transport remain semantic containers, while their covered siblings
 * become inert and leave the accessibility tree until collapse.
 */
function isolateCoveredBranches(
  boundary: HTMLElement,
  exposed: HTMLElement[],
): () => void {
  const snapshots: HiddenBranchSnapshot[] = [];
  const containsExposed = (node: HTMLElement): boolean => (
    exposed.some(item => item === node || node.contains(item))
  );

  const visit = (node: HTMLElement): void => {
    if (exposed.includes(node)) return;
    if (containsExposed(node)) {
      for (const child of node.children) {
        if (child instanceof HTMLElement) visit(child);
      }
      return;
    }
    snapshots.push({
      node,
      ariaHidden: node.getAttribute('aria-hidden'),
      inert: node.getAttribute('inert'),
    });
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('inert', '');
  };

  for (const child of boundary.children) {
    if (child instanceof HTMLElement) visit(child);
  }

  return () => {
    for (const { node, ariaHidden, inert } of snapshots) {
      if (ariaHidden === null) node.removeAttribute('aria-hidden');
      else node.setAttribute('aria-hidden', ariaHidden);
      if (inert === null) node.removeAttribute('inert');
      else node.setAttribute('inert', inert);
    }
  };
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
  paused = false,
  artUrl: artUrlOverride,
  artKey: artKeyOverride,
}: VisualizerPanelProps): React.ReactElement | null {
  const { t } = useTranslation();
  const enabled = useVisualizerStore(
    s => (surface === 'fullscreen' ? s.enabledFullscreen : s.enabledNowPlaying),
  );
  const mode = useVisualizerStore(s => s.mode);
  const cycleMode = useVisualizerStore(s => s.cycleMode);
  const expandedSurface = useVisualizerStore(s => s.expandedSurface);
  const toggleExpanded = useVisualizerStore(s => s.toggleExpanded);
  const setExpandedSurface = useVisualizerStore(s => s.setExpandedSurface);
  const defaultArt = useVisualizerCoverArt();
  const artUrl = artUrlOverride ?? defaultArt.artUrl;
  const artKey = artKeyOverride ?? defaultArt.artKey;
  const windowHidden = useWindowVisibility();
  const inlineRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const suppressFocusRestoreRef = useRef(false);
  const wasExpandedRef = useRef(false);
  const [inlineVisible, setInlineVisible] = useState(true);

  const isExpanded = expandedSurface === surface;
  const coveredByExpandedSurface = expandedSurface !== null && !isExpanded;
  const canvasPaused = windowHidden
    || paused
    || (!isExpanded && (!inlineVisible || coveredByExpandedSurface));

  const collapse = useCallback(() => setExpandedSurface(null), [setExpandedSurface]);
  const stopCardDrag = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);
  const onExpandClick = useCallback(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : expandButtonRef.current;
    requestTransientUiClose();
    toggleExpanded(surface);
  }, [toggleExpanded, surface]);

  // Offscreen dashboard cards retain their DOM for layout and drag ordering, but
  // must release the analyser feed until they are visible again.
  useEffect(() => {
    if (isExpanded || paused) return;
    const node = inlineRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      const entry = entries[0];
      if (entry) setInlineVisible(entry.isIntersecting);
    }, { threshold: 0.01 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [isExpanded, paused]);

  // Move focus into the portalled dialog, then restore the inline trigger after
  // an intentional collapse. Covered surfaces collapse without stealing focus
  // back from the surface that covered them.
  useEffect(() => {
    let raf = 0;
    const wasExpanded = wasExpandedRef.current;
    wasExpandedRef.current = isExpanded;

    if (isExpanded) {
      suppressFocusRestoreRef.current = false;
      raf = requestAnimationFrame(() => collapseButtonRef.current?.focus());
    } else if (wasExpanded) {
      const suppressRestore = suppressFocusRestoreRef.current;
      suppressFocusRestoreRef.current = false;
      if (!suppressRestore && expandedSurface === null && !paused) {
        raf = requestAnimationFrame(() => {
          const target = expandButtonRef.current ?? restoreFocusRef.current;
          if (target?.isConnected) target.focus();
        });
      }
    }

    return () => cancelAnimationFrame(raf);
  }, [expandedSurface, isExpanded, paused]);

  // Keep keyboard focus in the visible dialog + the deliberately exposed
  // transport strip. Everything else is covered and must not enter the tab
  // order. Escape is consumed before the parent fullscreen player sees it.
  useEffect(() => {
    if (!isExpanded) return;
    const exposedKind = surface === 'fullscreen' ? 'fullscreen' : 'shell';
    const exposedSelector = [
      `[data-visualizer-transport="${exposedKind}"]`,
      `[data-visualizer-overlay-exempt="${exposedKind}"]`,
    ].join(',');
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        collapse();
        return;
      }
      if (e.key !== 'Tab') return;

      const allowed = [
        ...focusableDescendants(overlayRef.current),
        ...[...document.querySelectorAll<HTMLElement>(exposedSelector)]
          .flatMap(focusableDescendants),
      ];
      const unique = [...new Set(allowed)];
      if (unique.length === 0) return;

      const current = unique.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      const next = current < 0
        ? (e.shiftKey ? unique.length - 1 : 0)
        : (current + (e.shiftKey ? -1 : 1) + unique.length) % unique.length;
      unique[next]?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isExpanded, collapse, surface]);

  useEffect(() => {
    if (!isExpanded || !overlayRef.current) return;
    const exposedKind = surface === 'fullscreen' ? 'fullscreen' : 'shell';
    const boundary = surface === 'fullscreen'
      ? overlayRef.current.parentElement
      : document.body;
    if (!boundary) return;
    const exposed = [
      overlayRef.current,
      ...boundary.querySelectorAll<HTMLElement>(
        `[data-visualizer-transport="${exposedKind}"], `
        + `[data-visualizer-overlay-exempt="${exposedKind}"]`,
      ),
    ];
    return isolateCoveredBranches(boundary, exposed);
  }, [isExpanded, surface]);

  // Exposed transport controls may open their own portalled UI. Collapse first
  // so that layer is not stranded outside this dialog's focus/isolation scope.
  useEffect(() => {
    if (!isExpanded) return;
    const collapseForTransientUi = () => {
      suppressFocusRestoreRef.current = true;
      collapse();
    };
    window.addEventListener(TRANSIENT_UI_OPEN_EVENT, collapseForTransientUi);
    return () => window.removeEventListener(TRANSIENT_UI_OPEN_EVENT, collapseForTransientUi);
  }, [isExpanded, collapse]);

  // Release runtime-only ownership when its surface disappears. Deferring the
  // check keeps React StrictMode's effect replay from clearing a still-mounted
  // overlay while also allowing a replacement owner for the same surface.
  useEffect(() => () => {
    queueMicrotask(() => {
      if (document.querySelector(`.psy-viz-overlay[data-surface="${surface}"]`)) return;
      const state = useVisualizerStore.getState();
      if (state.expandedSurface === surface) state.setExpandedSurface(null);
    });
  }, [surface]);

  // A disabled visualizer must not leave an overlay pinned open.
  useEffect(() => {
    if (!enabled && isExpanded) collapse();
  }, [enabled, isExpanded, collapse]);

  // Opening fullscreen or another covering surface retires this overlay and
  // lets that surface become the sole active visualizer owner.
  useEffect(() => {
    if (paused && isExpanded) collapse();
  }, [paused, isExpanded, collapse]);

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
        ref={isExpanded ? collapseButtonRef : expandButtonRef}
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
    // Fullscreen overlays stay inside the active aria-modal dialog. The normal
    // Now Playing overlay uses <body> to escape the draggable card's clipping
    // and stacking contexts.
    const portalHost = surface === 'fullscreen'
      ? document.querySelector<HTMLElement>('[data-visualizer-overlay-host="fullscreen"]') ?? document.body
      : document.body;
    return createPortal(
      <div
        ref={overlayRef}
        className="psy-viz-overlay"
        data-surface={surface}
        data-mode={mode}
        role="dialog"
        aria-label={t('visualizer.title', 'Visualizer')}
        // A portal moves the DOM node but not the React tree, so events still
        // bubble to this component's ancestors — on Now Playing that is the
        // card's drag source, which is mousedown-based. Without this, dragging
        // anywhere on a full-window visualizer starts repositioning the card
        // behind it. A card that fills the window has no meaningful position to
        // drag to anyway.
        onMouseDown={stopCardDrag}
      >
        <VisualizerCanvas
          artUrl={artUrl}
          artKey={artKey}
          paused={canvasPaused}
          className="psy-viz-canvas-full"
        />
        {controls}
      </div>,
      portalHost,
    );
  }

  return (
    <div
      ref={inlineRef}
      className={className ? `psy-viz-panel ${className}` : 'psy-viz-panel'}
      data-mode={mode}
      role="region"
      aria-label={t('visualizer.title', 'Visualizer')}
    >
      <VisualizerCanvas artUrl={artUrl} artKey={artKey} paused={canvasPaused} />
      {controls}
    </div>
  );
}
