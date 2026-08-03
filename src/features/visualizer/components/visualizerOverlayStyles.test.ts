import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('expanded visualizer geometry', () => {
  const css = readFileSync(
    resolve(process.cwd(), 'src/styles/components/visualizer.css'),
    'utf8',
  );

  it('applies shell titlebar and mobile offsets only to Now Playing overlays', () => {
    expect(css).toContain(
      "body:has(.app-shell[data-titlebar]) .psy-viz-overlay[data-surface='nowPlaying']",
    );
    expect(css).toContain(
      ".app-shell[data-mobile] ~ .psy-viz-overlay[data-surface='nowPlaying']",
    );
    expect(css).toContain(
      "body:has(.app-shell[data-mobile]) .psy-viz-overlay[data-surface='nowPlaying']",
    );
    expect(css).not.toContain('body:has(.app-shell[data-titlebar]) .psy-viz-overlay {');
    expect(css).not.toContain('body:has(.app-shell[data-mobile]) .psy-viz-overlay {');
  });

  it('keeps the immersive overlay above its tallest transport control', () => {
    expect(css).toContain(
      ".fs-player[data-visualizer-overlay-host='fullscreen'] > .psy-viz-overlay {\n  bottom: clamp(128px, 19vh, 136px);",
    );
  });
});
