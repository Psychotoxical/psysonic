# Psy Orbit

A "listen together" mode built into Psysonic. One participant hosts the music, others tune in and listen in sync. Guests can suggest tracks; the host decides what lands in the queue.

No external servers, no relays, no accounts on yet another platform — Orbit piggybacks entirely on your existing Navidrome instance. Sessions live in regular playlists (with a small JSON blob in the comment field), the clients poll and write to those playlists, and that's it.

---

## Table of contents

- [For users](#for-users)
  - [Starting a session (host)](#starting-a-session-host)
  - [Joining (guest)](#joining-guest)
  - [Suggesting tracks](#suggesting-tracks)
  - [Approvals](#approvals)
  - [Shared queue](#shared-queue)
  - [Session settings](#session-settings)
  - [Participants](#participants)
  - [Ending the session](#ending-the-session)
- [Requirements & limits](#requirements--limits)
- [How it works (technical)](#how-it-works-technical)
  - [Design goals](#design-goals)
  - [Playlists as transport](#playlists-as-transport)
  - [The invite link](#the-invite-link)
  - [The host tick](#the-host-tick)
  - [The guest tick](#the-guest-tick)
  - [Data flow](#data-flow)
  - [State shape](#state-shape)
  - [Cleanup](#cleanup)
  - [Security & privacy](#security--privacy)
- [Edge cases handled](#edge-cases-handled)
- [Code map](#code-map)

---

## For users

### Starting a session (host)

Click **Psy Orbit** in the top bar → **Create a session**. The start modal opens with:

- **Session name** — a random playful name is generated; edit it or reroll with the dice button.
- **Max guests** — cap on concurrent participants (1–32). You don't count.
- **Session server** — when your library scope includes several servers, choose the Navidrome instance that will host the session. Psysonic temporarily narrows the library scope and mixed queue to that server, then restores the previous scope when the session ends.
- **Invite link** — ready to copy and share the moment the modal opens. Pre-generated from a fresh session id + the slugified name.
- **Clear my queue first** — optional. Start with an empty queue (guest suggestions land fresh) vs. keep the chosen server's queued tracks and share them with the guests.

Click **Start Orbit**. The session bar appears at the top of the window (session name, participant count, shuffle countdown, settings / share / help / exit buttons). The link is now live — share it.

### Joining (guest)

Two equivalent paths:

1. **Paste anywhere** — copy the invite link the host sent you. Anywhere in Psysonic (not inside a text field), press `Ctrl+V` (`Cmd+V` on macOS). A confirm dialog shows who invited you; click Join.
2. **Launch popover** — click **Psy Orbit** in the top bar → **Join a session** → paste the link into the field → Join.

Either path performs the same preflight: validates the link, checks the session still exists, handles server switches automatically if the link points at another Navidrome you have an account for. If you have **multiple accounts** on the target server, a small picker asks which one to join as.

### Suggesting tracks

Anywhere a song row appears (album, playlist, favorites, artist top-songs, search results, random mix, advanced search):

- **Double-click** a row → adds just that track.
- **Right-click → "Add to Orbit session"** — same effect, via context menu.
- **Single-click** on a row shows a toast hint: "Double-click to add". This is deliberate — a single click normally drops the whole album into your queue, which would spam the shared queue and annoy everyone.

Explicit bulk buttons (**Play All** / **Play Album** / **Play Playlist** / Hero play / Album-card play) ask for a confirmation first inside an active session. On confirm, the tracks are **appended** to the shared queue, never replacing it.

### Approvals

By default, a new session starts with **auto-approve off**. Guest suggestions land in the session's suggestion history but not the actual playback queue — the host decides.

The host sees a prominent **Pending approvals** strip at the top of the queue panel: each pending track with cover, title, artist, and "Suggested by …" line, plus two buttons:

- ✓ Accept — enqueues the track into the host's player queue. Guests see it appear in the shared queue on the next tick.
- ✕ Decline — drops the suggestion. It stays in the suggestion history for audit but won't show up again in the approval strip.

Auto-approve can be toggled on in the session settings for any session where manual approval isn't needed.

### Shared queue

Both hosts and guests see a strip at the top of the queue panel with the session name and a comma-separated list of all participants (host first). Under that:

- **Host** view: regular queue, with any new guest suggestions injected into random positions inside the upcoming range.
- **Guest** view: read-only display of the host's upcoming queue (up to 30 tracks at a time) with submitter attribution — "by alice" for host-chosen tracks is omitted; "suggested by alice" is shown for guest suggestions.

When the guest has in-flight suggestions that haven't been merged yet, they appear in a separate **Waiting for host** section above Up next, with a clock icon. Once the host (auto-)approves and merges, they move into the normal list.

### Session settings

Open via the gear icon in the session bar (host only):

- **Auto-approve suggestions** — on/off. Default off.
- **Automatic reshuffle** — on/off. Periodically Fisher–Yates-shuffles the upcoming queue.
- **Reshuffle every** — 1 / 5 / 10 / 15 / 30 min preset picker. Disabled when auto-reshuffle is off.
- **Shuffle now** — one-shot manual shuffle + bumps the next-auto-shuffle timer.

One setting group is shared without appearing in this popover: the host's **track transitions** (crossfade, gapless, AutoDJ smooth-skip and the overlap cap). They are mirrored into the session automatically and refreshed every tick, so a mid-session change reaches the guests. Guests adopt the host's values for the duration and get their own back when they leave — their local transition controls are disabled while a session is running, with a note explaining why. The reason is timing: these settings decide *when* one track ends and the next begins, so if each client used its own, the timelines would drift apart at every single track boundary.

### Participants

Click the participant count in the session bar. Opens a popover:

- Host row at the top with a crown icon.
- Each connected guest with a user icon, username, and join timestamp.
- Host-only actions per guest:
  - **Remove** — drops them from the session; they can re-join via the invite link.
  - **Ban** — permanently blocked for the lifetime of the session.
  - **Mute** — they stay in the session and keep showing up in the participants list, but new suggestions from them are dropped during the host's sweep. Symmetric: the host can un-mute at any time. The guest's own UI reads the same flag and disables its Suggest controls, so it reads as a clear muted state rather than silent failures.

  Remove and Ban confirm before firing.

Guests see the same list but read-only — no action buttons.

### Ending the session

- **Host clicks X** → confirm dialog → session closes for everyone. Server playlists are deleted automatically.
- **Guest clicks X** → confirm dialog → just the guest leaves. Session continues for everyone else.
- **Host goes silent for 5 minutes** (network drop, app crash, laptop lid) → guests auto-leave with a dedicated "Host went silent" modal.
- **App close / force quit** → next app launch sweeps up any orphaned session playlists you own (`__psyorbit_*` with stale heartbeat).

### The help modal

Every screen with the session bar has a `?` icon between settings and X that opens a 9-section walk-through of everything above, with keyboard navigation (arrow keys between sections, Enter to expand).

---

## Requirements & limits

- **Same Navidrome server.** Everyone — host and all guests — must be logged into the same Navidrome instance. Orbit links encode the server URL, and Psysonic auto-switches on paste if you have an account there.
- **Separate accounts.** Each participant needs their own Navidrome user. If a host and guest log in as the same user, their outbox playlists collide and suggestions get lost. This is a hard limit of the current design — Orbit identifies participants by username.
- **Public server address for remote guests.** Guests outside your home network need your server reachable at a public hostname. The start modal warns you if you're currently connected via a LAN address.
- **Host presence matters.** Guests auto-leave after 5 minutes of no host activity. Shorter reconnects (network blips, phone screen off, whatever) are invisible.
- **Session size.** State is bounded to ~4 KB per playlist comment. Two caps keep it there: the suggestion history holds the 64 most recent entries, and the published upcoming queue is capped at 30 tracks (with a `+ N more` count for the rest). Neither limits the host's own playback queue, which is local and unbounded.

---

## How it works (technical)

### Design goals

1. **No external infrastructure.** Everything runs on your Navidrome. No relay, no auth server, no persistent state anywhere you don't already own.
2. **No protocol changes.** Uses Navidrome's existing Subsonic/OpenSubsonic playlist endpoints. If your server can host a normal playlist, it can host an Orbit session.
3. **Degrade gracefully.** A dropped tick doesn't break a session. Network blips are silent. Missing heartbeats expire cleanly. Crashes clean up on the next launch.
4. **Host-authoritative.** The host's player is the ground truth; guests mirror. No distributed consensus, no leader election.

### Playlists as transport

Every session creates two kinds of playlists on the server (names are stable and start with `__psyorbit_`):

| Playlist | Who owns it | What's in it |
|---|---|---|
| `__psyorbit_<sid>__` | host | Canonical session state (4 KB JSON blob) in the playlist **comment**. Track list is always empty. |
| `__psyorbit_<sid>_from_<user>__` | each participant | Outbox. Comment holds a heartbeat timestamp; the track list holds pending guest suggestions. |

`<sid>` is 8 lowercase hex characters. Note the trailing `__` on **both** names — it terminates the session name as well as the outbox name, which is what lets a single pattern recognise either.

All playlists are marked `public: true` so every participant can read them via the normal Subsonic endpoints (`getPlaylist.view`, `getPlaylists.view`). Psysonic filters `__psyorbit_*` out of its own UI (Playlists page, pickers, context menu), but the Navidrome web client will show them while a session is active.

### The invite link

An invite is a magic string, not a URL — it survives being pasted into chat clients that mangle custom schemes:

```
psysonic2-<base64url>
```

`<base64url>` is standard Base64 of the UTF-8 JSON below with `+`→`-`, `/`→`_` and padding stripped:

```json
{ "v": 1, "srv": "https://music.example.com", "k": "orbit", "sid": "a3f01c7d" }
```

- **`v` here is the share-payload version (1), not the session-state version (3).** They are independent.
- `srv` is normalised at encode time: trimmed, `http://` prepended when no scheme is present, trailing slash removed. A host with both a LAN and a public address publishes whichever one its share settings select — for a remote guest that must be the public one.
- `sid` must match `^[0-9a-f]{8}$`; it is lowercased on decode.
- The token is located by searching the pasted text for the prefix and then matching `[A-Za-z0-9_-]+`, so an invite still works when it arrives wrapped in a sentence.
- On decode, `srv` must parse as a URL with an `http:` or `https:` scheme — anything else is rejected before it reaches the join path.

Both paste paths (`Ctrl+V` anywhere, and the Join modal) then check the decoded `srv` against every address of every known server profile, normalising both sides before comparing. Comparing raw strings here is a trap: an address stored without a scheme never matches an invite that carries one.

### The host tick

Fired every 2.5 s from `useOrbitHost`:

1. **Sweep all outboxes.** List every `__psyorbit_<sid>_from_<user>__` playlist. For each one, read the current tracklist (= new suggestions from that guest) and the heartbeat timestamp from the comment.
2. **Apply snapshots to state.** Rebuild the `participants` array from heartbeat freshness (anyone with a heartbeat < 30 s old is "alive"). Append new suggestions to `state.queue` as `OrbitQueueItem { trackId, addedBy, addedAt }`, deduped by `(user, trackId)` and skipping muted or over-cap guests. `maxUsers` is enforced here — the host is the only writer, so it's the only place the cap can actually hold; earliest joiners win.
3. **Clear each swept outbox's tracklist** (heartbeat stays). Single-pass consume — a track the host has seen is the host's problem now, not the outbox's.
4. **Merge into player queue** (when auto-approve is on, and the suggestion isn't host-authored, already merged, or declined). Each merged track gets sprinkled at a random position in the upcoming range so host picks and guest suggestions interleave.
5. **Maybe shuffle.** If auto-shuffle is on and the interval elapsed, two lists move: `state.queue` (the guest-facing suggestion history) and the host's own upcoming play queue, both Fisher–Yates. `state.lastShuffle` is rewritten even when a list was too short to reorder, so the interval can't turn into a tight retry loop.
6. **Snapshot playback.** Write `isPlaying`, `positionMs`, `positionAt` (wall-clock), `currentTrack`, a 30-item slice of the upcoming play queue (`playQueue`) plus its untruncated length (`playQueueTotal`), and a refreshed copy of the host's transition prefs into the state blob.
7. **Write.** Serialise and push to the session playlist's comment via `updatePlaylist.view`.

Two details that matter for anyone reimplementing this:

- **The tick is not the only trigger.** A play/pause flip on the host pushes state immediately, out of band. Without it the worst case between "host hits pause" and "guest stops" is a host tick plus a guest tick — up to 5 s, long enough to be audible.
- **Pushes never overlap.** Mount, timer and the play/pause subscription all feed the same coalescing runner: while a push is in flight, further triggers collapse into exactly one follow-up run. A slow run that already swept and cleared an outbox must not lose its write to a faster one, or those suggestions are gone.

Host also writes a heartbeat to its own outbox every 10 s so the participants pipeline treats the host symmetrically.

### The guest tick

Fired from `useOrbitGuest` — fast polling (500 ms) until the first successful sync lands, then steady 2.5 s. In order:

1. **Read the session playlist comment** via `getPlaylist.view`. Parse the OrbitState. An unreadable result (playlist deleted, empty comment, unparseable JSON, version mismatch) is treated as session-ended — the host almost certainly ended the session and the `ended: true` write was missed because we polled after the subsequent delete.
2. **Host-timeout check.** `state.positionAt` older than 5 min → host-timeout exit. This runs *before* the `ended` check: a host that stopped writing never gets to set `ended` in the first place.
3. **Reconcile pending suggestions.** For every trackId the local client has submitted, check whether it appeared in `state.playQueue` or `state.currentTrack` — the host's *playable* queue, not `state.queue`, which is the suggestion history and fills up even under manual approval. If so, drop it from the local pending list.
   Then handle the lost-update race: a suggestion still missing from `state.queue` past a grace window was probably wiped by a racing sweep-clear, so re-send it (the host dedupes by `(user, trackId)`, so this is idempotent). Give up after 45 s so the row can't hang forever.
4. **Check session end:** `state.ended === true` → exit modal.
5. **Check kick / remove:** local username in `state.kicked` → kicked. An entry in `state.removed` counts only when its timestamp is newer than our own join time, otherwise a stale marker from a previous session-life would bounce us straight back out on re-join.
6. **Auto-sync to host.** Three cases:
   - Different track at host → load it locally (`playTrack`), seek to `estimateLivePosition(state, now)`, mirror `isPlaying`. Never touches the local player if the guest has locally diverged (paused on their own). A track that simply ended does *not* count as divergence — it's told apart from a manual pause by the playback position sitting at ~0.
   - Same track, play/pause flipped at host → mirror only if the guest hasn't locally diverged since the last tick.
   - First tick after join → mirror unconditionally (initial sync).
7. **Heartbeat tick** (independent, every 10 s): write `{ ts: Date.now() }` into the guest outbox comment.

### Data flow

```
Host (per tick)                  Navidrome                       Guest (per tick)
──────────────────────────────────────────────────────────────────────────────────
                                                                
player.currentTrack                                              
+ position                                                       
    │                                                            
    ▼                                                            
snapshotPlayerPatch ──► writeOrbitState ─┐                       
                                         │                       
                            ┌─session playlist─┐                 
                            │ comment = JSON   │ ◄─readOrbitState
                            └──────────────────┘                 
                                                    │            
                                                    ▼            
                                              parse OrbitState   
                                                    │            
                                                    ▼            
                                              syncToHost:        
                                              • getSong          
                                              • playTrack        
                                              • seek             
                                              • resume/pause     
                                                                 
                                                                 
Guest suggests track Y                                           
    ┌────────────────────────────────────────────────────────────┤
    │                                                            │
    ▼                                                            │
                                                    suggestOrbitTrack
                            ┌──guest outbox──┐                   
                            │ track list = Y │ ◄─updatePlaylist  
                            └────────────────┘                   
                                    │                            
                                    │                            
Host: sweepGuestOutboxes ◄──────────┘                            
    │                                                            
    ▼                                                            
applyOutboxSnapshotsToState                                      
(queue += Y, participants refreshed)                             
    │                                                            
    ▼ (if auto-approve)                                          
mergeNewSuggestionsIntoQueue                                     
    │                                                            
    ▼                                                            
player.enqueueAt ──► playQueue snapshot ──► session playlist ──► Guest reconciles
                                                                 pending list
```

### State shape

All relevant types in `src/features/orbit/api/orbit.ts`:

```ts
interface OrbitState {
  v: 3;
  sid: string;                 // 8 lowercase hex chars
  host: string;                // navidrome username
  name: string;                // human-readable session name
  started: number;             // ms since epoch
  maxUsers: number;
  currentTrack: OrbitQueueItem | null;
  isPlaying: boolean;
  positionMs: number;
  positionAt: number;          // wall-clock ms of the last snapshot
  queue: OrbitQueueItem[];     // suggestion history (64 most recent)
  lastShuffle: number;
  participants: OrbitParticipant[];
  kicked: string[];            // banned for the session's lifetime

  // Optional on the wire — a session hosted by an older build simply omits
  // them, and a reader must cope with their absence rather than reject.
  playQueue?: { trackId: string; addedBy: string }[];  // ≤30 upcoming, no addedAt
  playQueueTotal?: number;     // untruncated length, for a "+ N more" hint
  removed?: { user: string; at: number }[];            // soft-remove markers, 60 s TTL
  ended?: boolean;
  settings?: OrbitSettings;
  suggestionBlocked?: string[];                        // muted usernames
}

interface OrbitQueueItem {
  trackId: string;
  addedBy: string;             // navidrome username
  addedAt: number;
}

interface OrbitParticipant {
  user: string;
  joinedAt: number;
  lastHeartbeat: number;
}

interface OrbitSettings {
  autoApprove: boolean;
  autoShuffle: boolean;
  shuffleIntervalMin?: 1 | 5 | 10 | 15 | 30;   // absent → 15
  transitions?: OrbitTransitionSettings;
}

/**
 * The host's crossfade / gapless / AutoDJ prefs, mirrored so guests blend
 * tracks the same way. Otherwise every client uses its own transition
 * settings and the track boundary lands at a different moment on each one,
 * re-introducing exactly the drift Catch Up exists to fix.
 */
interface OrbitTransitionSettings {
  crossfadeEnabled: boolean;
  crossfadeSecs: number;
  crossfadeTrimSilence: boolean;
  autodjSmoothSkip: boolean;
  gaplessEnabled: boolean;
  autodjOverlapCapMode?: 'auto' | 'limit';
  autodjOverlapCapSec?: number;
}

/** The outbox playlist's comment. */
interface OrbitOutboxMeta {
  ts: number;                  // wall-clock ms of this heartbeat
}
```

**Version handling is strict today:** `parseOrbitState` rejects any blob whose `v` is not exactly `3`, so a client that publishes a higher version is invisible to every current build rather than partially understood. Additive fields are therefore introduced as *optional* and do not bump `v`.

Readers should be liberal about the rest: the outbox parser already ignores everything in the comment except `ts`, and `currentTrack` is not validated field-by-field — a malformed item degrades attribution in the UI, not correctness.

**Size budget.** The blob is capped at 4 KB of serialised JSON. The write path (`serialiseOrbitStateForWire`) does not throw when it would overflow — it sheds, in order: oldest entries from the suggestion history, then the tail of the published `playQueue`, retrying after each drop. Only the *published* blob shrinks; the host's local state keeps everything. This matters more than it looks: an earlier version threw instead, the host swallowed the error and retried the same too-large state forever, and every guest froze and eventually timed out. `serialiseOrbitState` (the throwing variant, `OrbitStateTooLarge`) still exists for callers that want to handle the overflow themselves.

### Cleanup

Two layers of defense against orphaned playlists:

1. **Explicit exit.** `endOrbitSession` (host) or `leaveOrbitSession` (guest) deletes the participant's own playlists synchronously. The happy path.
2. **App-start orphan sweep.** Every app launch runs `cleanupOrphanedOrbitPlaylists` across **every** configured server, not just the active one. Per server it lists all `__psyorbit_*` playlists, skips any owned by someone else, and decides per entry:
   - **Name doesn't match** `^__psyorbit_([a-f0-9]+)(_from_.+)?__$` → assumed corrupt, deleted.
   - **It's the session running on this device** → never touched.
   - Otherwise read a timestamp — `positionAt` for a session playlist, `ts` for an outbox — and delete when `ended: true` or the timestamp is older than 5 minutes.

   When the comment yields no usable timestamp (missing, unparseable, wrong shape), the sweep falls back to Navidrome's own `changed` field before deciding. Without that fallback a playlist created seconds ago — the one belonging to the session that is currently starting up — looks exactly like a dead one.

The 5-minute TTL is a conservative compromise: long enough to survive a brief app restart (and a session running on another device of yours), short enough that a dead session doesn't clutter the server indefinitely.

The name pattern is load-bearing: the trailing `__` has to sit outside the optional `_from_…` group. An earlier version kept it inside, so a bare session name never matched, fell into the corrupt branch, and deleted live sessions running on the user's other devices.

### Security & privacy

- **Authentication.** Uses Navidrome's own user system. Participants are identified by their username; no additional auth layer.
- **Public playlist visibility.** Session and outbox playlists must be `public: true` so guests can read them. Side effect: they're visible to *any* user on the same Navidrome instance while the session is active. Psysonic's own UI filters them; the Navidrome web client does not.
- **No external servers.** Orbit is strictly peer-to-peer via the Navidrome instance you already trust. No data leaves your server.
- **No message signing.** Since everything is owned by authenticated Navidrome users, we rely on the server's own ACLs. A guest can't modify the host's session playlist (different owner), only their own outbox.
- **Track IDs only.** The state blob references tracks by their Navidrome ID. No filenames, no paths, no stream URLs.

---

## Edge cases handled

- **Host offline < 15 s.** Silent. Guests extrapolate via `estimateLivePosition` (positionMs + elapsed wall-clock).
- **Host offline 15 s – 5 min.** Guest UI shows a yellow "Host offline" badge next to the session name. Playback continues locally.
- **Host offline > 5 min.** Guest auto-leaves with a "Host went silent" modal. Cleanup of guest outbox runs on dismissal.
- **Guest pauses locally.** The guest's local pause survives host track changes — the next-track event won't silently un-pause them. "Catch up" brings them back in sync.
- **Guest resume in orbit.** Pressing play (player bar, media keys, MPRIS) in an active session is interpreted as "catch up" — loads the host's current track and seeks to the live position, not "resume the locally frozen track".
- **Bulk "Play All" in-session.** Dialog: "Add 14 tracks to the Orbit queue?" On confirm, appended. On cancel, no-op.
- **Single-click on song row in-session.** Swallowed; shows "Double-click to add" toast.
- **Multiple accounts on target server.** Paste flow opens an account picker modal. Keyboard-navigable.
- **Server switch while in session.** The session remains bound to its original server; changing the visible active server cannot redirect playlist reads, writes, suggestions or cleanup.
- **Initial sync race.** The guest's first tick retries on a 500 ms cadence until the sync actually lands. Each attempt waits up to 5 s for the engine to report the track genuinely playing — `isPlaying` alone isn't enough, because it flips synchronously before a single sample has been produced, so the check also requires playback position to have moved past ~0.1 s. A failed attempt returns without recording an anchor, so the fast poll simply tries again. There is deliberately **no** blind apply at the deadline: seeking into a not-yet-ready engine silently no-ops, and the guest then plays from 0:00 while believing it is synced.
- **`positionAt` stale on join.** Seek fraction is clamped to [0, 0.99] — prevents `audio:ended` from firing at the very start of a join.
- **Outbox deletion mid-session** (cleanup race): host sees the guest drop out on the next sweep; guest's next heartbeat recreates the outbox if they're still connected.
- **Session playlist deleted** (cleanup race while the guest's local store says it's still active): guest treats as "ended", shows the exit modal.

---

## Code map

Everything lives under `src/features/orbit/`, reached from outside through the feature barrel `src/features/orbit/index.ts`. Paths below are relative to that folder unless stated otherwise.

### State and types
- `api/orbit.ts` — `OrbitState`, `OrbitQueueItem`, `OrbitParticipant`, `OrbitSettings`, `OrbitTransitionSettings`, playlist naming, wire constants, `makeInitialOrbitState`, `parseOrbitState`, `estimateLivePosition`. No imports of its own — pure protocol.
- `store/orbitStore.ts` — local session state: role, phase, session/playlist ids, `pendingSuggestions`, `mergedSuggestionKeys`, `declinedSuggestionKeys`, binding revision.
- `utils/constants.ts` — cadences and TTLs: heartbeat liveness, orphan TTL, shuffle interval, history cap, soft-remove TTL.

### Protocol logic
- `utils/orbit.ts` — internal re-export hub; the rest of the feature imports from here rather than from individual modules.
- `utils/helpers.ts` — session-id generation, state serialisation with the 4 KB shed strategy, outbox-name parsing, `suggestionKey`, the coalescing runner.
- `utils/stateMath.ts` — pure state folds: participant rebuild with `maxUsers` enforcement, suggestion dedupe, soft-remove ageing, shuffle, drift computation.
- `utils/remote.ts` — read/write the state blob and heartbeats; locate a session playlist by id.
- `utils/sweep.ts` — host-side outbox enumeration, read and single-pass clear.
- `utils/moderation.ts` — `kickOrbitParticipant` (ban), `removeOrbitParticipant` (soft remove), `setOrbitSuggestionBlocked` (mute).
- `utils/cleanup.ts` — app-start orphan sweep across all configured servers.
- `utils/pendingResend.ts` — guest-side mitigation for the outbox lost-update race.
- `utils/shareLink.ts` — build and parse invite magic strings, on top of `src/lib/share/shareLink.ts`.
- `utils/transitions.ts` — read the host's transition prefs; adopt, then restore the guest's own on leave.
- `utils/orbitServerScope.ts` · `utils/sessionActive.ts` — server-binding and session-liveness predicates used as guards throughout.
- `utils/orbitNames.ts` — random session-name generator for the start modal.
- `utils/orbitDiag.ts` — in-memory event log feeding the diagnostics popover.

### Lifecycle
- `utils/host.ts` — `startOrbitSession`, `endOrbitSession`, `updateOrbitSettings`, `triggerOrbitShuffleNow`, `hostEnqueueToOrbit`.
- `utils/guest.ts` — `joinOrbitSession`, `leaveOrbitSession`, `suggestOrbitTrack`, `ensureTrackInOutbox`, plus the suggest gate (`evaluateOrbitSuggestGate`, which is what surfaces the muted state) and — despite the file name — the host's `approveOrbitSuggestion` / `declineOrbitSuggestion`, since both act on a guest's suggestion.
- `utils/orbitBulkGuard.ts` — confirm-dialog gate invoked when more than one track lands in the queue during a session. Registers the Orbit runtime on module init.
- `src/store/orbitRuntime.ts` — neutral seam the audio core reads instead of importing the feature; the feature registers itself here at boot.
- `src/utils/server/switchActiveServer.ts` — switches the active account without tearing down the source-bound session.

### Hooks
- `hooks/useOrbitHost.ts` — host state tick, outbox sweep, merge pipeline, event-driven push on play/pause.
- `hooks/useOrbitGuest.ts` — guest state pull, auto-sync, host-timeout detection, pending reconciliation.
- `hooks/useOrbitOutboxHeartbeat.ts` — shared 10 s heartbeat writer for both roles.
- `hooks/useOrbitSongRowBehavior.ts` — double-click-to-add behaviour for song lists.
- `hooks/useOrbitBodyAttrs.ts` · `hooks/usePlaybackRateOrbitSync.ts` — body attributes for session-scoped styling; local playback-rate suppression.

### UI — session bar and popovers
- `components/OrbitSessionBar.tsx` — topbar strip with name, counts, shuffle timer, settings/share/help/catch-up/exit buttons.
- `components/OrbitSettingsPopover.tsx` — host settings (auto-approve, auto-shuffle, interval, manual shuffle).
- `components/OrbitSharePopover.tsx` — host-only invite-link popover with copy button.
- `components/OrbitParticipantsPopover.tsx` — participant list with remove/ban/mute (host-only actions).
- `components/OrbitDiagnosticsPopover.tsx` — live event log for debugging a session.

### UI — modals
- `components/OrbitStartModal.tsx` — session creation wizard.
- `components/OrbitJoinModal.tsx` — manual invite-link paste + join.
- `components/OrbitAccountPicker.tsx` — multi-account disambiguation when joining.
- `components/OrbitExitModal.tsx` — session-ended / kicked / removed / host-timeout exit notice.
- `components/OrbitHelpModal.tsx` — 9-section help walk-through (keyboard-navigable).
- `components/OrbitStartTrigger.tsx` — "Psy Orbit" button in the header + launch popover (create / join / help).
- `components/OrbitWordmark.tsx` — the Orbit lockup used by the trigger and modals.

### UI — queue views
- `components/OrbitQueueHead.tsx` — shared header strip (session name, participants, host-presence badge).
- `components/OrbitGuestQueue.tsx` — guest-side queue view (current track, pending suggestions, upcoming).
- `components/HostApprovalQueue.tsx` — host-side approval strip with accept/decline.

### Supporting
- `store/helpModalStore.ts` · `store/orbitAccountPickerStore.ts` — help-modal state, account picker for multi-account joins.
- `store/orbitSession.ts` — `isInOrbitSession()`, the predicate the queue and bulk-action paths gate on.
- `src/store/confirmModalStore.ts` + `src/ui/GlobalConfirmModal.tsx` — promise-based confirm dialog used by the bulk gate.
- `src/lib/api/subsonicPlaylists.ts` — every playlist call Orbit makes goes through here.
- `src/styles/components/orbit-session-top-strip.css` — session bar styling.
- `src/locales/*/orbit.ts` — user-facing strings, one file per locale.
