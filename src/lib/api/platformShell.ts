/**
 * Typed facade over the generated platform-shell commands (logging, window
 * decorations, Linux/Wayland render tweaks, app lifecycle). Plain commands pass
 * through (reject on error like invoke); Result-wrapped ones re-throw on error
 * so the call sites keep their existing reject semantics.
 *
 * `update_taskbar_icon` stays on raw `invoke` (Windows-cfg-gated, not exported).
 */
import { commands } from '@/generated/bindings';

export async function setLoggingMode(args: { mode: string }): Promise<void> {
  const res = await commands.setLoggingMode(args.mode);
  if (res.status === 'error') throw new Error(res.error);
}

export async function setSubsonicWireUserAgent(args: {
  userAgent: string;
  windowLabel: string;
}): Promise<void> {
  const res = await commands.setSubsonicWireUserAgent(args.userAgent, args.windowLabel);
  if (res.status === 'error') throw new Error(res.error);
}

export async function setLinuxWebkitSmoothScrolling(args: { enabled: boolean }): Promise<void> {
  const res = await commands.setLinuxWebkitSmoothScrolling(args.enabled);
  if (res.status === 'error') throw new Error(res.error);
}

export async function setLinuxWaylandTextRenderProfile(args: { profile: string }): Promise<void> {
  const res = await commands.setLinuxWaylandTextRenderProfile(args.profile);
  if (res.status === 'error') throw new Error(res.error);
}

export async function pauseRendering(): Promise<void> {
  const res = await commands.pauseRendering();
  if (res.status === 'error') throw new Error(res.error);
}

// --- plain (reject on error like invoke) ---

export function setWindowDecorations(args: { enabled: boolean }): Promise<void> {
  return commands.setWindowDecorations(args.enabled);
}

export function exitApp(): Promise<void> {
  return commands.exitApp();
}

export function linuxWaylandTextRenderSettingsAvailable(): Promise<boolean> {
  return commands.linuxWaylandTextRenderSettingsAvailable();
}

export function themeAnimationRisk(): Promise<boolean> {
  return commands.themeAnimationRisk();
}

export function noCompositingMode(): Promise<boolean> {
  return commands.noCompositingMode();
}

export function isTilingWmCmd(): Promise<boolean> {
  return commands.isTilingWmCmd();
}
