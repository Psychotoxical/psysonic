#!/usr/bin/env node
// Generates src/data/licenses.json — the data backing Settings → System → Open Source Licenses.
//
// Maintainer-only operation: run before each release to refresh the bundled
// dependency list. Requires `cargo-about` installed globally
// (`cargo install cargo-about --features cli`). The npm-side license data is
// read via npx without persisting a devDependency, so package.json stays clean
// and the nix-npm-deps-hash-sync workflow is not triggered.
//
// Output lives in src/ (not public/) so Vite bundles it as a lazy JS chunk
// — no runtime fetch, the data is fixed into the build artifact.
//
// Output format (per entry):
//   {
//     name: string,
//     version: string,
//     source: 'npm' | 'cargo',
//     licenses: string[],         // SPDX ids, may be multi (dual-licensed)
//     repository?: string,
//     homepage?: string,
//     description?: string,
//     publisher?: string,
//     licenseText?: string,       // full license text, may be empty if not found
//   }
//
// Usage: node scripts/generate-licenses.mjs

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TAURI_DIR = join(REPO_ROOT, 'src-tauri');
const OUT_DIR = join(REPO_ROOT, 'src', 'data');
const OUT_PATH = join(OUT_DIR, 'licenses.json');

function die(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

function step(msg) {
  console.log(`\x1b[36m→\x1b[0m ${msg}`);
}

function ok(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

// ── Cargo side via cargo-about ──────────────────────────────────────────────
function checkCargoAbout() {
  try {
    execSync('cargo about --version', { stdio: 'ignore' });
  } catch {
    die(
      'cargo-about not found. Install with:\n' +
      '    cargo install cargo-about --features cli',
    );
  }
}

function generateCargoLicenses() {
  step('Running cargo-about (this resolves the full dependency graph and may take ~30s)…');
  const result = spawnSync(
    'cargo',
    [
      'about',
      'generate',
      'about.hbs',
      '--config', 'about.toml',
      '--manifest-path', 'Cargo.toml',
      '--all-features',
    ],
    { cwd: TAURI_DIR, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    console.error(result.stderr);
    die('cargo-about failed.');
  }
  const parsed = JSON.parse(result.stdout);
  if (!parsed?.licenses) die('cargo-about output missing `licenses` key.');

  // Flatten: pivot from license-grouped to crate-grouped.
  const byCrate = new Map();
  for (const lic of parsed.licenses) {
    for (const u of lic.used_by ?? []) {
      const key = `${u.name}@${u.version}`;
      if (!byCrate.has(key)) {
        byCrate.set(key, {
          name: u.name,
          version: u.version,
          source: 'cargo',
          licenses: [],
          repository: u.repository || undefined,
          description: u.description || undefined,
          licenseText: '',
        });
      }
      const entry = byCrate.get(key);
      if (!entry.licenses.includes(lic.id)) entry.licenses.push(lic.id);
      // Append text — a crate may have multiple licenses (dual). Keep them all,
      // separated by a clear divider.
      if (lic.text) {
        if (entry.licenseText) {
          entry.licenseText += `\n\n--- ${lic.id} ---\n\n${lic.text}`;
        } else {
          entry.licenseText = lic.text;
        }
      }
    }
  }
  ok(`cargo: ${byCrate.size} crates`);
  return [...byCrate.values()];
}

// ── npm side via license-checker-rseidelsohn (npx) ──────────────────────────
function readLicenseFile(path) {
  if (!path || !existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

// Try to find a notice/copyright file alongside the license file.
function findExtraLicenseTexts(packagePath) {
  if (!packagePath || !existsSync(packagePath)) return '';
  let extra = '';
  try {
    const entries = readdirSync(packagePath);
    for (const name of entries) {
      const upper = name.toUpperCase();
      if (
        upper === 'NOTICE' ||
        upper === 'NOTICE.MD' ||
        upper === 'NOTICE.TXT' ||
        upper === 'COPYRIGHT' ||
        upper === 'COPYRIGHT.MD' ||
        upper === 'COPYRIGHT.TXT'
      ) {
        const full = join(packagePath, name);
        if (statSync(full).isFile()) {
          const txt = readFileSync(full, 'utf-8').trim();
          if (txt) extra += `\n\n--- ${name} ---\n\n${txt}`;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return extra;
}

function generateNpmLicenses() {
  step('Running license-checker-rseidelsohn via npx (this enumerates node_modules)…');
  const result = spawnSync(
    'npx',
    [
      '--yes',
      'license-checker-rseidelsohn@latest',
      '--json',
      '--production',
      '--excludePrivatePackages',
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    console.error(result.stderr);
    die('license-checker-rseidelsohn failed.');
  }
  const data = JSON.parse(result.stdout);
  const out = [];
  for (const [key, info] of Object.entries(data)) {
    // key looks like `package-name@1.2.3` or `@scope/name@1.2.3`.
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    const licenses = Array.isArray(info.licenses)
      ? info.licenses
      : typeof info.licenses === 'string'
        ? [info.licenses]
        : [];
    const text =
      readLicenseFile(info.licenseFile) +
      findExtraLicenseTexts(info.path);
    out.push({
      name,
      version,
      source: 'npm',
      licenses: licenses.map(String),
      repository: info.repository || undefined,
      homepage: info.url || undefined,
      publisher: info.publisher || undefined,
      description: undefined, // license-checker doesn't surface descriptions
      licenseText: text.trim(),
    });
  }
  ok(`npm: ${out.length} packages`);
  return out;
}

// ── Self ────────────────────────────────────────────────────────────────────
function readSelfPackageJson() {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  return {
    name: pkg.name ?? 'psysonic',
    version: pkg.version ?? '0.0.0',
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  step(`Generating ${OUT_PATH.replace(REPO_ROOT + '/', '')}`);
  mkdirSync(OUT_DIR, { recursive: true });
  checkCargoAbout();
  const cargoEntries = generateCargoLicenses();
  const npmEntries = generateNpmLicenses();

  const entries = [...cargoEntries, ...npmEntries];
  // Stable sort: name, then version. Case-insensitive on name.
  entries.sort((a, b) => {
    const n = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (n !== 0) return n;
    return a.version.localeCompare(b.version);
  });

  const self = readSelfPackageJson();
  const stats = {
    npm: npmEntries.length,
    cargo: cargoEntries.length,
    total: entries.length,
    withFullText: entries.filter((e) => e.licenseText && e.licenseText.length > 0).length,
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    project: self,
    stats,
    entries,
  };

  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 0) + '\n');
  const sizeKb = (statSync(OUT_PATH).size / 1024).toFixed(1);
  ok(`Wrote ${OUT_PATH} (${stats.total} entries, ${sizeKb} KB)`);
  ok(`  ${stats.cargo} cargo + ${stats.npm} npm; ${stats.withFullText} with full license text`);
}

main();
