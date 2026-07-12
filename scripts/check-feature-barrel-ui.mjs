#!/usr/bin/env node
/**
 * Guard: boot-critical feature barrels must not re-export UI modules.
 *
 * Re-exporting components/hooks that pull lucide-react through a barrel while
 * the same barrel (or its stores) is imported from boot paths creates production
 * init-order failures (`createLucideIcon is not a function` in minified chunks).
 *
 * Not every feature barrel is checked — album/artist/etc. export UI for lazy
 * routes and are safe. Only barrels that stores/utils on the boot path import
 * from are listed in BOOT_CRITICAL_BARRELS.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** Barrels whose non-UI surface is imported before or during first paint. */
const BOOT_CRITICAL_BARRELS = [
  { file: join(ROOT, 'src/features/offline/index.ts'), label: 'src/features/offline/index.ts' },
  { file: join(ROOT, 'src/music-network/index.ts'), label: 'src/music-network/index.ts' },
];

const FORBIDDEN_EXPORT_PATTERNS = [
  /from\s+['"]\.\/components\//,
  /from\s+['"]\.\/ui\//,
  /export\s+\*\s+from\s+['"]\.\/components\//,
  /export\s+\*\s+from\s+['"]\.\/ui\//,
  /export\s+\{[^}]*\}\s+from\s+['"]\.\/components\//,
  /export\s+\{[^}]*\}\s+from\s+['"]\.\/ui\//,
];

/** @param {string} file @param {string} label */
function checkBarrel(file, label) {
  const text = readFileSync(file, 'utf8');
  const hits = [];
  for (const re of FORBIDDEN_EXPORT_PATTERNS) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (re.test(line)) hits.push(trimmed);
    }
  }
  if (hits.length === 0) return [];
  return hits.map(h => `${label}: ${h}`);
}

const errors = [];

for (const { file, label } of BOOT_CRITICAL_BARRELS) {
  try {
    statSync(file);
    errors.push(...checkBarrel(file, label));
  } catch {
    errors.push(`${label}: missing barrel file`);
  }
}

if (errors.length > 0) {
  console.error('Boot-critical barrel UI re-export violations:\n');
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    '\nFix: remove UI exports from the root barrel; import from @/features/<x>/ui or deep paths.',
  );
  process.exit(1);
}

console.log('check-feature-barrel-ui: ok');
