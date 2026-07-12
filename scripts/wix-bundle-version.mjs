/**
 * Map package.json semver to a WiX/MSI bundle version for Tauri.
 *
 * `bundle.windows.wix.version` must be `major.minor.patch` or
 * `major.minor.patch.build` (four dot-separated integers, each ≤ 65535).
 * Alphabetic pre-releases (`-dev`, `-rc.N`) cannot be used here or in MSI
 * ProductVersion. NSIS accepts full semver without this mapping.
 *
 * Display / About still use the real package.json version.
 */

/** @param {string} version */
export function wixVersionOverrideForPackageVersion(version) {
  const trimmed = version.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+(\d+))?$/);
  if (!match) {
    throw new Error(`Invalid semver for WiX mapping: ${trimmed}`);
  }

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  const pre = match[4];
  const base = `${major}.${minor}.${patch}`;

  if (pre === undefined) {
    return null;
  }

  if (pre === 'dev') {
    return `${base}.65535`;
  }

  const rc = pre.match(/^rc\.(\d+)$/);
  if (rc) {
    const n = Number(rc[1]);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`WiX rc index must be 0–65535 (got rc.${rc[1]})`);
    }
    return `${base}.${n}`;
  }

  if (/^\d+$/.test(pre)) {
    // Numeric pre-release — Tauri converts the app version for WiX; no override.
    return null;
  }

  throw new Error(
    `Version "${trimmed}" has non-numeric pre-release "${pre}" — MSI/WiX cannot bundle it. ` +
      'Use NSIS (`--bundles nsis`) or extend wix-bundle-version.mjs.',
  );
}

/** @deprecated Use wixVersionOverrideForPackageVersion — kept for tests. */
export function toWixBundleVersion(version) {
  const override = wixVersionOverrideForPackageVersion(version);
  if (override !== null) {
    return override;
  }
  const trimmed = version.trim();
  const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Invalid semver: ${trimmed}`);
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}
