import { useEffect, useMemo, useState } from 'react';
import { getCachedBlob } from '@/cover/imageCache';
import { useThemeStore } from '@/store/themeStore';
import {
  swatchesFromObjectUrl,
  type CoverSwatches,
} from '@/features/visualizer/utils/coverPalette';
import { buildPalette, type VisualizerPalette } from '@/features/visualizer/utils/visualizerColors';
import type { VisualizerColorSource } from '@/features/visualizer/store/visualizerStore';

/**
 * Palette for the visualizer: either the current cover's own colours or the
 * active theme's accent ramp, in both cases adapted to the theme background it
 * will be drawn on.
 *
 * This deliberately does not reuse `useFsDynamicAccent`: the fullscreen player
 * *renders* a visualizer, so importing from that feature would close an import
 * cycle dependency-cruiser rejects. It also wants something different — one
 * WCAG-corrected accent for text, where this wants several honest swatches.
 */

/** artKey → swatches. Module-level so same-album tracks resolve without a
 *  second decode, and so the palette survives remounting a surface.
 *  A null entry records "we looked and there was no usable colour". */
const swatchCache = new Map<string, CoverSwatches | null>();

/** CSS custom properties the palette is built from. */
interface ThemeColors {
  accent: string | null;
  accentDim: string | null;
  surface: string | null;
}

function readCssVar(name: string): string | null {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name);
    return value.trim() || null;
  } catch {
    return null;
  }
}

function readThemeColors(): ThemeColors {
  if (typeof document === 'undefined') {
    return { accent: null, accentDim: null, surface: null };
  }
  return {
    accent: readCssVar('--accent'),
    accentDim: readCssVar('--accent-dim'),
    // The visualizer sits on a card inline and on the app background when
    // expanded; `--bg-app` is the better contrast reference for both since the
    // card is a near-transparent tint of it.
    surface: readCssVar('--bg-app') ?? readCssVar('--bg-card'),
  };
}

export function useVisualizerPalette(
  artUrl: string,
  artKey: string,
  colorSource: VisualizerColorSource,
): VisualizerPalette {
  const wantsCover = colorSource === 'album';
  const cached = wantsCover && artKey && artUrl ? swatchCache.get(artKey) ?? null : null;
  const [, bump] = useState(0);

  // Theme variables live in the DOM, so they are re-read whenever the active
  // theme changes. Subscribing to the store is what makes a theme switch
  // repaint the visualizer instead of stranding it on the old colours.
  const theme = useThemeStore(s => s.theme);
  const [themeColors, setThemeColors] = useState<ThemeColors>(readThemeColors);

  useEffect(() => {
    // Deferred to the next frame on purpose: the theme class/attribute is
    // applied by another component's effect, which may run after this one, so
    // reading synchronously here would sample the *previous* theme's variables.
    const raf = requestAnimationFrame(() => setThemeColors(readThemeColors()));
    return () => cancelAnimationFrame(raf);
  }, [theme]);

  useEffect(() => {
    if (!wantsCover || !artKey || !artUrl || swatchCache.has(artKey)) return;
    let cancelled = false;
    let blobUrl = '';
    void (async () => {
      try {
        // Route through the cover cache (mem + IDB) rather than a raw fetch —
        // the cover is usually already cached by the player UI.
        const blob = await getCachedBlob(artUrl, artKey);
        if (cancelled || !blob) return;
        blobUrl = URL.createObjectURL(blob);
        const swatches = await swatchesFromObjectUrl(blobUrl);
        if (cancelled) return;
        // Cache the null too: a cover with no usable colour should fall back to
        // the theme once, not re-decode on every render.
        swatchCache.set(artKey, swatches);
        bump(n => n + 1);
      } catch {
        /* fall back to the theme palette */
      } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    })();
    return () => { cancelled = true; };
  }, [artKey, artUrl, wantsCover]);

  const { accent, accentDim, surface } = themeColors;
  return useMemo(
    () => buildPalette({
      cover: wantsCover ? cached : null,
      themeAccent: accent,
      themeAccentDim: accentDim,
      surface,
    }),
    [cached, wantsCover, accent, accentDim, surface],
  );
}
