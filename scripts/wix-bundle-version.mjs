/**
 * Map package.json semver to a monotonic WiX/MSI ProductVersion for Tauri.
 *
 * `bundle.windows.wix.version` must be `major.minor.patch.build` (four integers
 * ≤ 65535). Alphabetic pre-releases cannot be used directly. NSIS accepts full
 * semver without this mapping.
 *
 * Build bands (monotonic within X.Y.Z so in-place MSI upgrades work across
 * dev → rc → stable):
 *   dev     → .1
 *   rc.N    → .10000 + N
 *   stable  → .65534
 *
 * Display / About still use the real package.json version.
 */

/** @type {const} */
export const WIX_BUILD = {
  DEV: 1,
  RC_BASE: 10_000,
  STABLE: 65_534,
};

const MAX_WIX_FIELD = 65_535;

/** @param {number} build */
function assertBuildField(build, label) {
  if (!Number.isInteger(build) || build < 0 || build > MAX_WIX_FIELD) {
    throw new Error(`WiX build field out of range for ${label}: ${build}`);
  }
}

/**
 * WiX dot version for bundle.windows.wix.version (always four parts for channels
 * we ship).
 * @param {string} version
 */
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
  const buildPart = match[5];
  const base = `${major}.${minor}.${patch}`;

  if (buildPart !== undefined) {
    throw new Error(
      `Version "${trimmed}" has +build metadata — map manually or drop build for WiX`,
    );
  }

  if (pre === undefined) {
    return `${base}.${WIX_BUILD.STABLE}`;
  }

  if (pre === 'dev') {
    return `${base}.${WIX_BUILD.DEV}`;
  }

  const rc = pre.match(/^rc\.(\d+)$/);
  if (rc) {
    const n = Number(rc[1]);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`WiX rc index must be ≥ 1 (got rc.${rc[1]})`);
    }
    const build = WIX_BUILD.RC_BASE + n;
    assertBuildField(build, `rc.${n}`);
    return `${base}.${build}`;
  }

  if (/^\d+$/.test(pre)) {
    const n = Number(pre);
    const build = WIX_BUILD.RC_BASE + n;
    assertBuildField(build, `pre ${pre}`);
    return `${base}.${build}`;
  }

  throw new Error(
    `Version "${trimmed}" has non-numeric pre-release "${pre}" — MSI/WiX cannot bundle it. ` +
      'Use NSIS (`--bundles nsis`) or extend wix-bundle-version.mjs.',
  );
}

/** Numeric build field from mapped WiX version (for monotonicity tests). */
export function wixMappedBuildNumber(packageVersion) {
  const wix = wixVersionOverrideForPackageVersion(packageVersion);
  const build = Number(wix.split('.')[3]);
  assertBuildField(build, packageVersion);
  return build;
}
