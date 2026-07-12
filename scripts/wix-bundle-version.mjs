/**
 * Map package.json semver to a WiX/MSI-compatible version string for Tauri.
 *
 * MSI ProductVersion is four numeric fields (each ≤ 65535). Tauri's WiX bundler
 * accepts semver with a numeric-only pre-release (`1.2.3-4`) or build (`1.2.3+4`),
 * not alphabetic tags like `-dev` or `-rc.3`.
 *
 * Display / About still use the real package.json version — this is bundle-only.
 */

/** @param {string} version */
export function toWixBundleVersion(version) {
  const trimmed = version.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+(\d+))?$/);
  if (!match) {
    throw new Error(`Invalid semver for WiX mapping: ${trimmed}`);
  }

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  const pre = match[4];
  const build = match[5];
  const base = `${major}.${minor}.${patch}`;

  if (build !== undefined) {
    const n = Number(build);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`WiX build metadata must be 0–65535 (got +${build})`);
    }
    return `${base}+${n}`;
  }

  if (pre === undefined) {
    return base;
  }

  if (pre === 'dev') {
    return `${base}-65535`;
  }

  const rc = pre.match(/^rc\.(\d+)$/);
  if (rc) {
    const n = Number(rc[1]);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`WiX rc index must be 0–65535 (got rc.${rc[1]})`);
    }
    return `${base}-${n}`;
  }

  if (/^\d+$/.test(pre)) {
    const n = Number(pre);
    if (n > 65535) {
      throw new Error(`WiX pre-release must be ≤ 65535 (got -${pre})`);
    }
    return `${base}-${n}`;
  }

  throw new Error(
    `Version "${trimmed}" has non-numeric pre-release "${pre}" — MSI/WiX cannot bundle it. ` +
      'Use NSIS (`--bundles nsis`) or map to a numeric pre-release for WiX.',
  );
}

/**
 * WiX version override for tauri.conf, or null when the app version already works.
 * @param {string} version
 */
export function wixVersionOverrideForPackageVersion(version) {
  const trimmed = version.trim();
  const wix = toWixBundleVersion(trimmed);
  return wix === trimmed ? null : wix;
}
