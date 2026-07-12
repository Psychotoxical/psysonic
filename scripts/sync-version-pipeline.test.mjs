/**
 * Integration tests for promotion/version sync: npm version → sync-tauri → sync-wix.
 * Simulates tauri.conf.json state after the full pipeline (no file I/O).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  wixMappedBuildNumber,
  wixVersionOverrideForPackageVersion,
} from './wix-bundle-version.mjs';

/** Mirrors sync-tauri + sync-wix effects on tauri.conf.json. */
function confAfterVersionSync(packageVersion, priorConf) {
  const conf = structuredClone(priorConf);
  conf.version = packageVersion;
  conf.bundle ??= {};
  conf.bundle.windows ??= {};
  const override = wixVersionOverrideForPackageVersion(packageVersion);
  conf.bundle.windows.wix = { ...(conf.bundle.windows.wix ?? {}), version: override };
  return conf;
}

const baseConf = {
  version: '1.49.0-dev',
  bundle: {
    windows: {
      nsis: { installMode: 'currentUser' },
      wix: { version: '1.49.0.1' },
    },
  },
};

describe('version promotion pipeline (sync-tauri + sync-wix)', () => {
  it('main → next: dev to first RC increases WiX build', () => {
    const conf = confAfterVersionSync('1.50.0-rc.1', baseConf);
    assert.equal(conf.version, '1.50.0-rc.1');
    assert.equal(conf.bundle.windows.wix.version, '1.50.0.10001');
    assert.ok(
      wixMappedBuildNumber('1.50.0-rc.1') > wixMappedBuildNumber('1.50.0-dev'),
    );
  });

  it('next RC bump: rc.1 to rc.2', () => {
    const from = confAfterVersionSync('1.50.0-rc.1', baseConf);
    const conf = confAfterVersionSync('1.50.0-rc.2', from);
    assert.equal(conf.version, '1.50.0-rc.2');
    assert.equal(conf.bundle.windows.wix.version, '1.50.0.10002');
  });

  it('next → release: RC to stable increases WiX build', () => {
    const from = confAfterVersionSync('1.50.0-rc.3', baseConf);
    const conf = confAfterVersionSync('1.50.0', from);
    assert.equal(conf.version, '1.50.0');
    assert.equal(conf.bundle.windows.wix.version, '1.50.0.65534');
    assert.ok(wixMappedBuildNumber('1.50.0') > wixMappedBuildNumber('1.50.0-rc.3'));
  });

  it('post-release: next minor dev resets build band on new line', () => {
    const from = confAfterVersionSync('1.50.0', baseConf);
    const conf = confAfterVersionSync('1.51.0-dev', from);
    assert.equal(conf.version, '1.51.0-dev');
    assert.equal(conf.bundle.windows.wix.version, '1.51.0.1');
  });

  it('stable release sets highest build in line', () => {
    const conf = confAfterVersionSync('2.0.0', {
      version: '2.0.0-rc.1',
      bundle: { windows: { wix: { version: '2.0.0.10001' } } },
    });
    assert.equal(conf.version, '2.0.0');
    assert.equal(conf.bundle.windows.wix.version, '2.0.0.65534');
  });
});

describe('sync-tauri-version-from-package.js invokes sync-wix', () => {
  it('calls sync-wix-bundle-version.mjs after updating conf.version', () => {
    const source = readFileSync(new URL('./sync-tauri-version-from-package.js', import.meta.url), 'utf8');
    assert.match(source, /sync-wix-bundle-version\.mjs/);
    const wixCall = source.indexOf('sync-wix-bundle-version');
    const versionWrite = source.indexOf('conf.version = version');
    assert.ok(wixCall > versionWrite, 'sync-wix must run after conf.version is set');
  });
});
