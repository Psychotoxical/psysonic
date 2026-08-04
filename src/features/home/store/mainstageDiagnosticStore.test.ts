import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAINSTAGE_DIAGNOSTIC_SECTION_IDS,
  createMainstageDiagnosticSections,
  restoreMainstageDiagnosticSections,
  snapshotMainstageDiagnosticSections,
  useMainstageDiagnosticStore,
} from '@/features/home/store/mainstageDiagnosticStore';

describe('mainstageDiagnosticStore', () => {
  beforeEach(() => {
    useMainstageDiagnosticStore.setState({ sections: createMainstageDiagnosticSections() });
    localStorage.clear();
  });

  it('starts every Mainstage section enabled and idle without persisted state', () => {
    const { sections } = useMainstageDiagnosticStore.getState();

    expect(Object.keys(sections)).toEqual(MAINSTAGE_DIAGNOSTIC_SECTION_IDS);
    for (const section of Object.values(sections)) {
      expect(section).toEqual({
        enabled: true,
        status: 'idle',
        durationMs: null,
        itemCount: null,
      });
    }
    expect(localStorage.length).toBe(0);
  });

  it('records a loading run and its terminal generation information', () => {
    const { start, finish } = useMainstageDiagnosticStore.getState();

    start('discoverSongs');
    expect(useMainstageDiagnosticStore.getState().sections.discoverSongs).toEqual({
      enabled: true,
      status: 'loading',
      durationMs: null,
      itemCount: null,
    });

    finish('discoverSongs', {
      status: 'ready',
      durationMs: 142,
      itemCount: 18,
      detail: 'library cache',
    });
    expect(useMainstageDiagnosticStore.getState().sections.discoverSongs).toEqual({
      enabled: true,
      status: 'ready',
      durationMs: 142,
      itemCount: 18,
      detail: 'library cache',
    });
  });

  it('clears diagnostics when disabled and returns to idle when enabled', () => {
    const { finish, setEnabled, toggle } = useMainstageDiagnosticStore.getState();
    finish('hero', { status: 'error', durationMs: 900, itemCount: 2, detail: 'failed' });

    setEnabled('hero', false);
    expect(useMainstageDiagnosticStore.getState().sections.hero).toEqual({
      enabled: false,
      status: 'disabled',
      durationMs: null,
      itemCount: null,
    });

    useMainstageDiagnosticStore.getState().start('hero');
    useMainstageDiagnosticStore.getState().finish('hero', { status: 'ready', itemCount: 1 });
    expect(useMainstageDiagnosticStore.getState().sections.hero.status).toBe('disabled');

    toggle('hero');
    expect(useMainstageDiagnosticStore.getState().sections.hero).toEqual({
      enabled: true,
      status: 'idle',
      durationMs: null,
      itemCount: null,
    });
  });

  it('resets all session diagnostics', () => {
    const { setEnabled, finish, reset } = useMainstageDiagnosticStore.getState();
    setEnabled('recent', false);
    finish('starred', { status: 'empty', durationMs: 12, itemCount: 0 });

    reset();

    expect(useMainstageDiagnosticStore.getState().sections).toEqual(createMainstageDiagnosticSections());
    expect(localStorage.length).toBe(0);
  });

  it('restores user toggles and diagnostic results after temporary collection', () => {
    useMainstageDiagnosticStore.getState().setEnabled('recent', false);
    useMainstageDiagnosticStore.getState().finish('hero', {
      status: 'ready',
      durationMs: 42,
      itemCount: 3,
      detail: 'before benchmark',
    });
    const snapshot = snapshotMainstageDiagnosticSections();

    useMainstageDiagnosticStore.getState().reset();
    useMainstageDiagnosticStore.getState().finish('hero', {
      status: 'timeout',
      durationMs: 30_000,
    });
    restoreMainstageDiagnosticSections(snapshot);

    const sections = useMainstageDiagnosticStore.getState().sections;
    expect(sections.recent).toMatchObject({ enabled: false, status: 'disabled' });
    expect(sections.hero).toMatchObject({
      enabled: true,
      status: 'ready',
      durationMs: 42,
      itemCount: 3,
      detail: 'before benchmark',
    });
  });
});
