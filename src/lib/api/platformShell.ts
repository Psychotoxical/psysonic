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

export async function resumeRendering(): Promise<void> {
  const res = await commands.resumeRendering();
  if (res.status === 'error') throw new Error(res.error);
}

// --- plain (reject on error like invoke) ---

export async function setWindowDecorations(args: {
  enabled: boolean;
  generation: number;
  transition: number;
}): Promise<boolean> {
  const res = await commands.setWindowDecorations(
    args.enabled,
    args.generation,
    args.transition,
  );
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export function exitApp(): Promise<void> {
  return commands.exitApp();
}

export function windowLifecycleGeneration(): Promise<number> {
  return commands.windowLifecycleGeneration();
}

export async function windowLifecycleHide(args: {
  generation: number;
  transition: number;
}): Promise<boolean> {
  const res = await commands.windowLifecycleHide(args.generation, args.transition);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function windowLifecycleBegin(args: {
  generation: number;
  attempt: number;
}): Promise<void> {
  const res = await commands.windowLifecycleBegin(args.generation, args.attempt);
  if (res.status === 'error') throw new Error(res.error);
}

export function windowLifecycleReady(args: {
  generation: number;
  attempt: number;
  minimizeToTray: boolean;
}): Promise<void> {
  return commands.windowLifecycleReady(
    args.generation,
    args.attempt,
    args.minimizeToTray,
  );
}

export async function windowLifecycleFallback(args: {
  generation: number;
  attempt: number;
  minimizeToTray: boolean;
}): Promise<void> {
  const res = await commands.windowLifecycleFallback(
    args.generation,
    args.attempt,
    args.minimizeToTray,
  );
  if (res.status === 'error') throw new Error(res.error);
}

export function windowLifecycleUpdateFallbackPolicy(args: {
  generation: number;
  minimizeToTray: boolean;
}): Promise<void> {
  return commands.windowLifecycleUpdateFallbackPolicy(args.generation, args.minimizeToTray);
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
