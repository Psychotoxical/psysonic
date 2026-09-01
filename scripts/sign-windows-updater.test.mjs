import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  WINDOWS_TARGET,
  authenticodeSignatureSize,
  versionFromTag,
  windowsInstallerName,
} from './sign-windows-updater.mjs';

const require = createRequire(import.meta.url);
const { assetUrl, validateSignature, withPlatform } = require('./lib/updater-manifest.cjs');

// Minimal PE image: MZ stub, PE signature, COFF header, optional header with
// the data directories — only the certificate-table entry is filled in.
function fakePe({ plus, certSize, directoryIndex = 4 }) {
  const peOffset = 0x80;
  const optionalHeader = peOffset + 24;
  const directories = optionalHeader + (plus ? 112 : 96);
  const buf = Buffer.alloc(directories + 16 * 8);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.writeUInt32LE(0x00004550, peOffset);
  buf.writeUInt16LE(plus ? 0x20b : 0x10b, optionalHeader);
  if (certSize > 0) {
    buf.writeUInt32LE(0x1000, directories + directoryIndex * 8);
    buf.writeUInt32LE(certSize, directories + directoryIndex * 8 + 4);
  }
  return buf;
}

describe('authenticodeSignatureSize', () => {
  it('reads the certificate table of a PE32+ image', () => {
    assert.equal(authenticodeSignatureSize(fakePe({ plus: true, certSize: 10360 })), 10360);
  });

  it('reads the certificate table of a PE32 image (Inno Setup stubs are 32-bit)', () => {
    assert.equal(authenticodeSignatureSize(fakePe({ plus: false, certSize: 9000 })), 9000);
  });

  it('returns 0 for an unsigned image', () => {
    assert.equal(authenticodeSignatureSize(fakePe({ plus: true, certSize: 0 })), 0);
    assert.equal(authenticodeSignatureSize(fakePe({ plus: false, certSize: 0 })), 0);
  });

  it('only looks at directory entry 4, not a neighbour', () => {
    assert.equal(authenticodeSignatureSize(fakePe({ plus: true, certSize: 500, directoryIndex: 3 })), 0);
    assert.equal(authenticodeSignatureSize(fakePe({ plus: true, certSize: 500, directoryIndex: 5 })), 0);
  });

  it('rejects files that are not PE images', () => {
    assert.throws(() => authenticodeSignatureSize(Buffer.from('not an exe at all, just text padding......................')), /MZ header/);
    const noPeSig = fakePe({ plus: true, certSize: 1 });
    noPeSig.writeUInt32LE(0, 0x80);
    assert.throws(() => authenticodeSignatureSize(noPeSig), /PE signature/);
    const badMagic = fakePe({ plus: true, certSize: 1 });
    badMagic.writeUInt16LE(0x107, 0x80 + 24);
    assert.throws(() => authenticodeSignatureSize(badMagic), /magic/);
  });
});

describe('release naming', () => {
  it('derives the version from stable and RC tags', () => {
    assert.equal(versionFromTag('app-v1.53.0'), '1.53.0');
    assert.equal(versionFromTag('app-v1.53.0-rc.2'), '1.53.0-rc.2');
  });

  it('rejects tags that are not app-v*', () => {
    assert.throws(() => versionFromTag('v1.53.0'), /expected app-v/);
    assert.throws(() => versionFromTag('app-v'), /expected app-v/);
  });

  it('names the installer the way the release assets are named', () => {
    assert.equal(windowsInstallerName('1.53.0'), 'Psysonic_1.53.0_x64-setup.exe');
    assert.equal(
      assetUrl('app-v1.53.0', windowsInstallerName('1.53.0')),
      'https://github.com/Psysonic/psysonic/releases/download/app-v1.53.0/Psysonic_1.53.0_x64-setup.exe'
    );
  });
});

describe('manifest', () => {
  const darwin = {
    version: '1.53.0',
    notes: 'notes',
    pub_date: '2026-09-01T00:00:00.000Z',
    platforms: {
      'darwin-aarch64': { signature: 'sig-a', url: 'https://example.invalid/a' },
      'darwin-x86_64': { signature: 'sig-x', url: 'https://example.invalid/x' },
    },
  };

  it('adds the Windows entry next to the macOS ones', () => {
    const next = withPlatform(darwin, WINDOWS_TARGET, { signature: 'sig-w', url: 'https://example.invalid/w' });
    assert.deepEqual(Object.keys(next.platforms), ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']);
    assert.deepEqual(next.platforms['windows-x86_64'], { signature: 'sig-w', url: 'https://example.invalid/w' });
    assert.equal(next.version, '1.53.0');
    assert.equal(next.notes, 'notes');
    assert.deepEqual(darwin.platforms['windows-x86_64'], undefined, 'input is not mutated');
  });

  it('replaces an existing Windows entry on re-run', () => {
    const once = withPlatform(darwin, WINDOWS_TARGET, { signature: 'old', url: 'https://example.invalid/w' });
    const twice = withPlatform(once, WINDOWS_TARGET, { signature: 'new', url: 'https://example.invalid/w' });
    assert.equal(twice.platforms['windows-x86_64'].signature, 'new');
    assert.equal(Object.keys(twice.platforms).length, 3);
  });

  it('works on a manifest without platforms', () => {
    const next = withPlatform({ version: '1.53.0' }, WINDOWS_TARGET, { signature: 's', url: 'u' });
    assert.deepEqual(next.platforms, { 'windows-x86_64': { signature: 's', url: 'u' } });
  });
});

describe('validateSignature', () => {
  it('accepts a base64-encoded minisign signature block', () => {
    const sig = Buffer.from(
      'untrusted comment: signature from tauri secret key\n' +
      'RUSI4IfUy5F5i6RBNcWYC/5ww/vcKgbi6Tx7sY4hfgDfw+h5MZb1TUOy15I1xWQiz0QTwEWIGI8aUQqYunGdTzHIA1z2EnQnpgA=\n' +
      'trusted comment: timestamp:1788116478\tfile:Psysonic_1.53.0_x64-setup.exe\n' +
      '9M2KenBiO/ory5bz5SOY7GW2/hnh9w6jBL2Boi6xWyROq4Z1u1s+84HZF3QvS8JIcP6267Tg9F2tgParlzYBAA==\n',
      'utf8'
    ).toString('base64');
    assert.doesNotThrow(() => validateSignature(sig, WINDOWS_TARGET, 'x.sig'));
  });

  it('rejects a public key handed in as a signature', () => {
    assert.throws(
      () => validateSignature('RWSI4IfUy5F5i8nqc7E8xfjpnTujhxGiDGscd8+A40TcEiamU+lQPac9', WINDOWS_TARGET, 'x.sig'),
      /PUBLIC KEY/
    );
  });

  it('rejects something too short to be a signature', () => {
    assert.throws(() => validateSignature('dW50cnVzdGVk', WINDOWS_TARGET, 'x.sig'), /too short/);
  });
});
