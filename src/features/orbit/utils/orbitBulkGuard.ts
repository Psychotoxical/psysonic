import { useOrbitStore } from '@/features/orbit/store/orbitStore';
import { useConfirmModalStore } from '@/store/confirmModalStore';
import i18n from '@/lib/i18n';
import { registerOrbitRuntime } from '@/store/orbitRuntime';

/**
 * Ask the user before dropping many tracks into the shared Orbit queue.
 *
 * Returns `true` when there's no active Orbit session, when `count <= 1`, or
 * when the user accepted the confirm dialog. Returns `false` only when an
 * active-Orbit user explicitly cancelled.
 *
 * The audio core reaches this (and the orbit session snapshot) through the
 * neutral `@/store/orbitRuntime` seam, not by importing the orbit feature.
 */
export async function orbitBulkGuard(count: number): Promise<boolean> {
  const role = useOrbitStore.getState().role;
  if (role !== 'host' && role !== 'guest') return true;
  if (count <= 1) return true;

  return useConfirmModalStore.getState().request({
    title: i18n.t('orbit.bulkConfirmTitle'),
    message: i18n.t('orbit.bulkConfirmBody', { count }),
    confirmLabel: i18n.t('orbit.bulkConfirmYes'),
    cancelLabel: i18n.t('orbit.bulkConfirmNo'),
  });
}

// Install the orbit runtime into the core seam at module init. The
// @/features/orbit barrel re-exports this module, so the topbar's barrel import
// evaluates it at boot — before any Orbit session can start.
registerOrbitRuntime({
  getSnapshot: () => {
    const o = useOrbitStore.getState();
    return { role: o.role, phase: o.phase, state: o.state };
  },
  bulkGuard: orbitBulkGuard,
});
