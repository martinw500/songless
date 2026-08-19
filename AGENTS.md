# Songless repository instructions

These instructions apply to the entire repository.

## Visual quality

- Treat user screenshots as the visual authority. Match their scale, alignment, spacing, softness, iconography, and motion before adding unrelated decoration.
- Verify optical alignment from the visible pixels, not only from a wrapper's bounding box. For asymmetric icons, check both axes and account for visual weight; for result screens, measure the visible group from artwork through stamp against the game-card center.
- Use inline SVG for interface icons. Do not approximate play, skip, volume, restart, dice, search, or timer symbols with CSS borders, text glyphs, or clipped pseudo-elements.
- Interactive state changes need meaningful motion. Elements that are added or removed from the stage timeline must expand, collapse, and reflow; they must not simply pop in or disappear.
- Motion should communicate cause and hierarchy: controls react first, layout follows, and result emphasis lands last. Prefer transform and opacity animation and avoid layout jitter.
- Wins should feel celebratory and losses should feel conclusive. Keep effects inside the game card and respect `prefers-reduced-motion`.
- Preserve responsive behavior. Check the 1918x1079 desktop reference size and at least one narrow viewport after material layout changes.

## Interaction invariants

- Enabled stage pills define both the actual audio durations and the visible timeline. They must never disagree.
- The timeline has three independent visual layers: a translucent unlocked range, an opaque actually-played range, and section dividers above both fills. Never use segment backgrounds or a static current-stage cursor to merge those meanings.
- Adding a duration earlier than the current clue makes that newly added duration current. It must not appear as a completed/passed segment.
- Keep at least one stage enabled and persist stage and volume preferences locally.
- Range controls must visibly distinguish the filled portion before the thumb from the unfilled portion after it.
- Stage durations are cumulative from the song start. An 8-second clue always plays 0-8 seconds, never only the interval after the previous clue. Active audio swaps the play glyph for a centered pause glyph and advances the timeline from its far-left edge across every elapsed boundary.
- Skipping preserves the last completed opaque range and extends only the new interval with translucent accent, without placing explanatory text over the player. Starting or replaying resets the opaque sweep to song time zero. Stopping a partial replay restores the last completed opaque range.
- Difficulty selection must work from both the side rail and central tabs.
- `Reroll all` is always available. `Play again` appears only after a loss.
- Search-result selection and guess submission remain separate actions.

## Documentation and verification

- Update the relevant Markdown documentation whenever behavior, controls, deployment, media handling, or architecture changes.
- Run `npm run typecheck`, `npm run build`, `npm run verify:ui`, and `git diff --check` before handoff.
- For visual changes, render the real app and inspect playing, win, and loss states. Exercise any changed interaction rather than inferring behavior from source.
- Reproduce the exact interaction sequence from a reported bug, including toggling a stage off, restoring it before the current selection, and clicking between durations. A passing build is not a visual regression check.
- Playback checks must observe the UI while a clip is actually active; a static playing class or a timeout inferred from source is insufficient.
- Do not claim that an element is centered, animated, or fixed unless the rendered evidence directly proves that specific claim.

See `docs/UI-QUALITY.md` for the product-level visual and motion specification.
