import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { COVER_ART_REGISTERED_SIZES } from './coverArtRegisteredSizes';

const registry = new Set<number>(COVER_ART_REGISTERED_SIZES);

/** Matches `coverArtCacheKey(foo, 300)` literals (second argument numeric). */
const COVER_KEY_SIZE_RX = /\bcoverArtCacheKey\([^)]*,\s*(\d+)/g;

function walkSrc(dir: string, files: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === 'dist') continue;
      walkSrc(p, files);
    } else if (/\.(tsx?|jsx?)$/.test(ent.name)) {
      files.push(p);
    }
  }
}

describe('COVER_ART_REGISTERED_SIZES', () => {
  it('includes every literal coverArtCacheKey size used under src/', () => {
    const root = join(process.cwd(), 'src');
    const files: string[] = [];
    walkSrc(root, files);
    const used = new Set<number>();
    for (const fp of files) {
      const s = readFileSync(fp, 'utf8');
      for (const m of s.matchAll(COVER_KEY_SIZE_RX)) {
        used.add(Number(m[1]));
      }
    }
    const missing = [...used].filter(n => !registry.has(n)).sort((a, b) => a - b);
    if (missing.length > 0) {
      throw new Error(`COVER_ART_REGISTERED_SIZES is missing: ${missing.join(', ')}`);
    }
  });
});
