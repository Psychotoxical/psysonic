import { IS_LINUX, IS_MACOS } from '@/lib/util/platform';

/** Matches Rust `performance_cpu_snapshot` (Linux `/proc`, macOS sysinfo). */
export function perfLiveCpuSnapshotSupported(): boolean {
  return IS_LINUX || IS_MACOS;
}
