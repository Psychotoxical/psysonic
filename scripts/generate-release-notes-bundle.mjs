#!/usr/bin/env node
/**
 * Build src/generated/releaseNotesBundle.ts for production bundles.
 * Embeds only the ## [X.Y.Z] slice for package.json version (dev, RC, and stable).
 * tauri:dev reads live markdown from the repo via Vite ?raw imports instead.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findReleaseSection } from './extract-release-section.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const whatsNewPath = join(root, 'WHATS_NEW.md');
const changelogPath = join(root, 'CHANGELOG.md');
const whatsNewFull = readFileSync(whatsNewPath, 'utf8');
const changelogFull = readFileSync(changelogPath, 'utf8');

function sliceForVersion(full, fileLabel) {
  const entry = findReleaseSection(full, version);
  if (!entry?.body) {
    console.warn(`warn: no section in ${fileLabel} for ${version} — embedding empty slice`);
    return '';
  }
  const dateSuffix = entry.date ? ` - ${entry.date}` : '';
  return `## [${entry.headerVersion}]${dateSuffix}\n\n${entry.body}`;
}

const whatsNewRaw = sliceForVersion(whatsNewFull, 'WHATS_NEW.md');
const changelogRaw = sliceForVersion(changelogFull, 'CHANGELOG.md');

const outDir = join(root, 'src/generated');
mkdirSync(outDir, { recursive: true });

const ts = `/** @generated — run: node scripts/generate-release-notes-bundle.mjs */
export const WHATS_NEW_RAW: string = ${JSON.stringify(whatsNewRaw)};

export const CHANGELOG_RAW: string = ${JSON.stringify(changelogRaw)};
`;

writeFileSync(join(outDir, 'releaseNotesBundle.ts'), ts, 'utf8');
console.log(`wrote src/generated/releaseNotesBundle.ts (sliced for ${version})`);
