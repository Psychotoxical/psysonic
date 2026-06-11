#!/usr/bin/env node
/**
 * Extract the body of a ## [version] section from a Keep-a-Changelog-style file.
 * Resolution matches src/utils/releaseNotes/releaseNotesMatch.ts.
 *
 * Usage: node scripts/extract-release-section.mjs <file> <version> [--allow-empty]
 * Stdout: section body (no ## header). Exit 1 if empty unless --allow-empty.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER_CORE = /^v?(\d+\.\d+\.\d+)/i;

function versionCore(version) {
  const m = version.trim().match(SEMVER_CORE);
  return m ? m[1] : null;
}

function isPlainTriple(header) {
  return /^\d+\.\d+\.\d+$/.test(header.trim());
}

function splitBlocks(raw) {
  return raw.split(/\n(?=## \[)/).filter((b) => b.startsWith('## ['));
}

function headerVersion(block) {
  const m = block.match(/^## \[([^\]]+)\]/);
  return m ? m[1] : null;
}

function parseBlock(block) {
  const lines = block.split('\n');
  const m = lines[0].match(/## \[([^\]]+)\](?:\s*-\s*(.+))?/);
  if (!m) return null;
  return {
    headerVersion: m[1],
    date: (m[2] ?? '').trim(),
    body: lines.slice(1).join('\n').trim(),
  };
}

export function findReleaseSection(raw, appVersion) {
  const blocks = splitBlocks(raw);

  const exact = blocks.find((b) => b.startsWith(`## [${appVersion}]`));
  if (exact) return parseBlock(exact);

  const appCore = versionCore(appVersion);
  if (!appCore) return null;

  const candidates = blocks.filter((b) => {
    const hv = headerVersion(b);
    return hv !== null && versionCore(hv) === appCore;
  });
  if (candidates.length === 0) return null;

  const plain = candidates.find((b) => {
    const hv = headerVersion(b);
    return hv !== null && isPlainTriple(hv);
  });
  return parseBlock(plain ?? candidates[0]);
}

function main() {
  const args = process.argv.slice(2);
  const allowEmpty = args.includes('--allow-empty');
  const positional = args.filter((a) => a !== '--allow-empty');
  const [file, version] = positional;

  if (!file || !version) {
    console.error('Usage: node scripts/extract-release-section.mjs <file> <version> [--allow-empty]');
    process.exit(2);
  }

  const raw = readFileSync(file, 'utf8');
  const entry = findReleaseSection(raw, version);
  const body = entry?.body?.trim() ?? '';

  if (!body) {
    if (allowEmpty) process.exit(0);
    console.error(`No release section found in ${file} for version ${version}`);
    process.exit(1);
  }

  process.stdout.write(`${body}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
