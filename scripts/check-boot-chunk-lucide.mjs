#!/usr/bin/env node
/**
 * Post-build guard: boot-adjacent Vite chunks must not bundle lucide-react.
 *
 * When a store/utils barrel accidentally re-exports UI, Rollup may pull
 * createLucideIcon into authStore/offline chunks and hit TDZ init-order bugs
 * in production (Windows WebView2: "X is not a function" on splash).
 *
 * Run after `npm run build` — no Tauri compile needed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(new URL('..', import.meta.url).pathname, 'dist/assets');

/** Chunk filename prefixes that must stay lucide-free. */
const BOOT_CHUNK_PREFIXES = ['authStore-', 'offline-'];

/** Minified bundles still embed lucide module paths or icon factory calls. */
const LUCIDE_SIGNALS = [
  'lucide-react',
  'createLucideIcon',
  // Common preset/offline icons pulled through bad barrels (minified arg strings):
  '("globe"',
  '("settings"',
  '("wifi-off"',
  '("download"',
];

let files;
try {
  files = readdirSync(DIST).filter(f => f.endsWith('.js'));
} catch {
  console.error('check-boot-chunk-lucide: dist/assets not found — run `npm run build` first.');
  process.exit(1);
}

const violations = [];

for (const file of files) {
  if (!BOOT_CHUNK_PREFIXES.some(p => file.startsWith(p))) continue;
  const text = readFileSync(join(DIST, file), 'utf8');
  for (const signal of LUCIDE_SIGNALS) {
    if (text.includes(signal)) {
      violations.push({ file, signal });
    }
  }
}

if (violations.length > 0) {
  console.error('Lucide leaked into boot-critical chunks:\n');
  for (const { file, signal } of violations) {
    console.error(`  • dist/assets/${file} — matched "${signal}"`);
  }
  console.error(
    '\nFix: split UI from the feature root barrel; import UI from @/features/<x>/ui only in components.',
  );
  process.exit(1);
}

console.log('check-boot-chunk-lucide: ok');
