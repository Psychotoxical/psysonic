/**
 * Orbit feature — multi-user listen-together: the shared-session state types
 * and Navidrome-playlist transport (`api/orbit`), host/guest lifecycle +
 * moderation + outbox sweep + drift math (`utils/*`), the orbit stores, the
 * session/account hooks, and all Orbit UI (session bar, modals, popovers,
 * guest queue, wordmark). Replaces the former `utils/orbit.ts` re-export shim.
 *
 * Playback-core (`playTrackAction`, `nextAction`, `queueMutationActions`,
 * `resumeAction`, `playbackRateStore`, `playbackReportSession`, `previewStore`)
 * drives orbit and so consumes this barrel — the correct playback→orbit edge,
 * realized early (playback moves last in M3). `nextActionOrbitRadio.test.ts`
 * stays out: it tests `nextAction` (playback-core), not orbit.
 */
export * from './api/orbit';
export * from './hooks/useOrbitBodyAttrs';
export * from './hooks/useOrbitGuest';
export * from './hooks/useOrbitHost';
export * from './hooks/useOrbitOutboxHeartbeat';
export * from './hooks/useOrbitSongRowBehavior';
export * from './hooks/usePlaybackRateOrbitSync';
export * from './store/orbitAccountPickerStore';
export * from './store/orbitSession';
export * from './store/orbitStore';
export * from './utils/cleanup';
export * from './utils/constants';
export * from './utils/guest';
export * from './utils/helpers';
export * from './utils/host';
export * from './utils/moderation';
export * from './utils/orbitBulkGuard';
export * from './utils/orbitDiag';
export * from './utils/orbitNames';
export * from './utils/pendingResend';
export * from './utils/remote';
export * from './utils/sessionActive';
export * from './utils/shareLink';
export * from './utils/stateMath';
export * from './utils/sweep';
export * from './utils/transitions';
export { default as OrbitAccountPicker } from './components/OrbitAccountPicker';
export { default as OrbitDiagnosticsPopover } from './components/OrbitDiagnosticsPopover';
export { default as OrbitExitModal } from './components/OrbitExitModal';
export { default as OrbitGuestQueue } from './components/OrbitGuestQueue';
export { default as OrbitHelpModal } from './components/OrbitHelpModal';
export { default as OrbitJoinModal } from './components/OrbitJoinModal';
export { default as OrbitParticipantsPopover } from './components/OrbitParticipantsPopover';
export { default as OrbitQueueHead } from './components/OrbitQueueHead';
export { default as OrbitSessionBar } from './components/OrbitSessionBar';
export { default as OrbitSettingsPopover } from './components/OrbitSettingsPopover';
export { default as OrbitSharePopover } from './components/OrbitSharePopover';
export { default as OrbitStartModal } from './components/OrbitStartModal';
export { default as OrbitStartTrigger } from './components/OrbitStartTrigger';
export { default as OrbitWordmark } from './components/OrbitWordmark';
