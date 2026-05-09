# PR: Clean up Queue Toolbar layout

## Summary
Refactors the Queue Panel toolbar for better visual hierarchy and removes redundant controls.

## Changes

### QueuePanel (`src/components/QueuePanel.tsx`)

**Removed:**
- Crossfade button and popover (redundant — already available in Settings)
- Gapless playback button (redundant — already available in Settings)

**Reorganized toolbar layout:**
```
[Save] [Load] [Share] | [Infinite] [Shuffle] [Clear]
       Group 1        |       Group 2
```

**New grouping logic:**
- **Left group (Playlist Management):** Save playlist, Load playlist, Share queue
- **Separator:** Visual divider between management and operations
- **Right group (Queue Operations):** Infinite queue (mode toggle), Shuffle (action), Clear (destructive action)

### PlayerBar (`src/components/PlayerBar.tsx`)

**No changes** — Equalizer button remains in the PlayerBar where it belongs as an audio processing control.

## Rationale

1. **Reduced redundancy:** Crossfade and gapless are configuration settings that don't need quick toggling from the queue panel. They're better suited for the Settings page.

2. **Logical grouping:** The toolbar now separates playlist management (persistent actions) from queue manipulation (runtime actions).

3. **Better UX flow:** Infinite queue → Shuffle → Clear follows a natural progression from "mode setting" to "immediate action" to "destructive action".

## Testing
- [ ] Verify all toolbar buttons still function correctly
- [ ] Verify tooltips display properly
- [ ] Check responsive layout on smaller screens
- [ ] Ensure keyboard navigation works across groups

## Screenshots
*(Add before/after screenshots if applicable)*
