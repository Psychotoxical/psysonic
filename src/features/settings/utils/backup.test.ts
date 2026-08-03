import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
  open: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeFile: mocks.writeFile,
  readTextFile: vi.fn(),
}));
vi.mock('@/generated/bindings', () => ({
  commands: {
    backupExportLibraryDb: vi.fn(),
    backupImportLibraryDb: vi.fn(),
  },
}));

import { exportBackupToPath, restoreBackupStores } from './backup';

beforeEach(() => {
  mocks.writeFile.mockReset();
  localStorage.clear();
});

describe('settings backup stores', () => {
  it('round-trips visualizer preferences and Now Playing card layout', async () => {
    const visualizer = { state: { enabled: true, mode: 'radial', fps: 45 }, version: 0 };
    const layout = {
      state: {
        cards: [{ id: 'visualizer', column: 'right', visible: false }],
      },
      version: 0,
    };
    localStorage.setItem('psysonic_visualizer', JSON.stringify(visualizer));
    localStorage.setItem('psysonic_np_layout', JSON.stringify(layout));

    await exportBackupToPath('config', '/tmp/settings.psybkp');
    const bytes = mocks.writeFile.mock.calls[0]?.[1] as Uint8Array;
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      stores: Record<string, unknown>;
    };
    expect(manifest.stores.psysonic_visualizer).toEqual(visualizer);
    expect(manifest.stores.psysonic_np_layout).toEqual(layout);

    localStorage.clear();
    restoreBackupStores(manifest.stores);
    expect(JSON.parse(localStorage.getItem('psysonic_visualizer') ?? 'null')).toEqual(visualizer);
    expect(JSON.parse(localStorage.getItem('psysonic_np_layout') ?? 'null')).toEqual(layout);
  });
});
