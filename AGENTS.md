# Songless repository instructions

These instructions apply to the entire repository.

## Visual quality

- Treat user screenshots as the visual authority. Match their scale, alignment, spacing, softness, iconography, and motion before adding unrelated decoration.
- Verify optical alignment from the visible pixels, not only from a wrapper's bounding box. For result screens, measure the visible group from artwork through stamp against the game-card center.
- Use inline SVG for interface icons. Do not approximate play, skip, volume, restart, dice, search, or timer symbols with CSS borders, text glyphs, or clipped pseudo-elements.
- Interactive state changes need meaningful motion. Elements that are added or removed from the stage timeline must expand, collapse, and reflow; they must not simply pop in or disappear.
- Motion should communicate cause and hierarchy: controls react first, layout follows, and result emphasis lands last. Prefer transform and opacity animation and avoid layout jitter.
- Wins should feel celebratory and losses should feel conclusive. Keep effects inside the game card and respect `prefers-reduced-motion`.
- Preserve responsive behavior. Check the 1918x1079 desktop reference size and at least one narrow viewport after material layout changes.

## Interaction invariants

- Enabled stage pills define both the actual audio durations and the visible timeline. They must never disagree.
- The timeline uses one persistent current-stage cursor. It must move on the same curve as segment reflow and must not jump to a new segment before that segment finishes moving.
- Keep at least one stage enabled and persist stage and volume preferences locally.
- Difficulty selection must work from both the side rail and central tabs.
- `Reroll all` is always available. `Play again` appears only after a loss.
- Search-result selection and guess submission remain separate actions.

## Documentation and verification

- Update the relevant Markdown documentation whenever behavior, controls, deployment, media handling, or architecture changes.
- Run `npm run typecheck`, `npm run build`, and `git diff --check` before handoff.
- For visual changes, render the real app and inspect playing, win, and loss states. Exercise any changed interaction rather than inferring behavior from source.
- Do not claim that an element is centered, animated, or fixed unless the rendered evidence directly proves that specific claim.

See `docs/UI-QUALITY.md` for the product-level visual and motion specification.
