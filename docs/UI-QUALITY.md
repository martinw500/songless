# UI quality and motion

This document is the acceptance guide for Songless interface work. The goal is a game that feels deliberate and responsive, not merely functional.

## Visual hierarchy

The center game card is the primary surface. Difficulty controls and settings support it without competing with the play control or result reveal. Colors follow the selected difficulty during play; loss uses a red wash and win uses the selected accent with brighter green celebration details.

The play glyph, skip icon, settings icons, and side actions use SVG artwork so their edges remain complete and smooth at every size. Optical centering is judged from the rendered shape, especially for asymmetric play and skip symbols.

Hosted clue loading replaces the play glyph with an inline-SVG progress ring and exposes `aria-busy` until decoded playback starts. The audio loader retries brief network, rate-limit, and server failures while keeping the same round position; the pending control remains clickable so the player can cancel without waiting for the request timeout.

## Stage configuration

The stage pills toggle the durations used by the round. The timeline keeps a stable node for every available duration and animates each enabled segment between zero and its weighted width. This lets neighboring segments slide into their new positions when a duration is added or removed.

Timeline meaning is split into three independent layers. The unlocked range is a continuous translucent accent from zero through the current clue endpoint. The actually played range is an opaque accent from zero through the playback head. Segment borders sit above both fills and remain visible in every state. A narrow glow at the opaque range edge is the live playback head; there is no static current-stage cursor.

Changing the stage configuration stops active audio and saves the selection to local storage. Removing the current duration selects the next longer enabled duration (falling back to the longest remaining duration). Adding a duration earlier than the current duration makes the newly added duration current, preventing it from being painted as an already-passed clue. At least one duration remains enabled.

Stage configuration is pre-round setup. The first Play click locks all stage pills for the remainder of that song, including after skips, wrong guesses, completed clues, and result reveal. A full round reset or new song unlocks them again. Locked pills retain enough color to communicate the chosen configuration but have no hover/press response.

Skip itself is silent. Advancing from 2 to 8 only unlocks the translucent 2-8 interval and leaves the completed 0-2 range opaque. The next Play runs song time 2 through 8 while continuing the opaque layer from the 2-second boundary. Once that continuation reaches 8, the following Play begins the cumulative 0-8 replay and restarts the opaque sweep from the far-left edge. Pausing freezes both audio and the opaque sweep at the exact elapsed timestamp; the next Play resumes from that point.

Skipping or submitting a wrong answer silently unlocks the next interval without starting it. The previously completed range remains opaque, the newly available interval receives translucent accent, and its later playback edge has no extra cursor or decorative blip. Routine instructions such as “Skipped” or “You now have 2 seconds” never appear over the player. The default stages are 0.1, 0.5, 2, 8, and 15 seconds; 0.01 seconds is an optional setting.

## Result choreography

The visible result group—not an oversized invisible wrapper—is centered in the game card.

Entering either win or loss stops clue playback and immediately restarts the selected song intro or hook from game-time zero. It must never inherit the 15-second clue position. Starting a new round, rerolling, or changing difficulty stops that reveal playback.

Artwork is optional and must follow the current song identity. Each changed song creates a fresh image request; missing, throttled, or failed artwork renders the stable fallback instead of retaining decoded pixels from the previous cover. Search-result thumbnails load lazily to avoid unnecessary R2 request bursts.

Auto reroll is opt-in and persists locally. A win or loss remains visible for a four-second countdown, with reveal audio continuing in the background. At zero, the app stops that reveal and begins a clean round with an unseen song in the same difficulty. The result screen exposes a one-round Cancel control without disabling the saved preference. Its Next song action advances immediately on either outcome, while a loss also exposes Retry for the same song. Disabling the option or manually advancing cancels any pending transition.

Loss sequence:

1. The game card receives a red wash.
2. Artwork resolves into place.
3. The reveal label, title, and artist rise in sequence.
4. The `Lost!` mark lands like a stamp.

Win sequence:

1. The game card receives an accent-colored success wash.
2. Artwork pops in with expanding success rings.
3. A contained confetti burst radiates around the artwork.
4. The title and artist enter, followed by the angled time stamp and its echo ring.

All choreography is reduced to near-instant state changes when `prefers-reduced-motion: reduce` is enabled.

## Phone layout

A round must fit inside the small viewport, the height a phone has with its browser toolbars showing. This is a playback correctness rule, not a density preference. Mobile browsers collapse their toolbar only once a page becomes scrollable, and iOS re-expands it when media starts, which drags the entire round down as audio begins and back up when it stops. Nothing in the page moves, so no CSS rule can be blamed and no desktop check can catch it; the only defence is a layout that never becomes scrollable.

Below 760px the layout therefore sizes to `svh` rather than `vh` or `dvh`, on `html`, `body`, `#root`, `.app-shell`, and `.game-layout` alike. A single `vh` anywhere reintroduces the shift, because it measures the viewport with the toolbar hidden and forces the document past the height actually available. `.game-card` carries no fixed height at these widths: it grows to absorb whatever the mode and settings panels leave, and never shrinks, since the card clips its overflow. The result screen must fit too, or the toolbar collapses there and the next round's first Play brings it back.

## Visual acceptance checklist

- Render at 1918x1079 and confirm the center card and supporting rails match the reference proportions.
- Inspect the play glyph and skip SVG at their rendered sizes; neither may look shifted, clipped, or broken.
- Toggle a disabled stage on and an enabled stage off. Confirm the timeline visibly expands and collapses over time and that the displayed/audio duration follows the new first stage.
- Remove the current first stage, restore it, then toggle earlier and later durations in succession. The restored earlier stage must become current and the translucent unlocked range must reflow continuously with the segment layout.
- Press Play once, then attempt to toggle every stage pill. All pills must be disabled and neither the configured stages nor timeline geometry may change until a full round reset.
- Complete a clue and then skip. The completed interval must stay opaque, only the new interval may be translucent, and every section divider must remain visible above both fills.
- Set volume to a partial value. The track before the thumb must use the difficulty accent and the track after the thumb must remain dark.
- Stage toggles must not place routine “stage added” or “stage removed” text over the play control.
- Complete 2 seconds and press Skip. Confirm the stage changes to 8 while audio remains stopped and only 2-8 becomes translucent. Press Play and confirm audio and opaque progress run from 2-8. After completion, press Play again and confirm both restart from 0.
- During the cumulative 0-8 replay, press Pause between stage boundaries. Audio and opaque progress must remain at that exact point, and the next Play must continue from it instead of jumping back to 2 seconds or restarting at zero.
- Trigger both a win and loss. Confirm the visible artwork-to-stamp group is optically centered and no result content is clipped.
- Enable auto reroll, finish a round, cancel the visible countdown, and confirm the result stays put. On the next result, let the four-second countdown advance to a different song without carrying over reveal audio or locked round state.
- Confirm Next song is available directly on both outcomes and Retry is available directly on a loss.
- Observe the transition rather than only its final frame. Win confetti should be visible but contained, and the stamp should be the final emphasis.
- Check a narrow viewport and the reduced-motion media mode.
- At a 390x844 phone viewport, sample element rectangles while a clip is genuinely playing and again once it stops. `.game-content`, `.stage-track`, `.play-button`, and `.guess-form` must not move, and the document must not be taller than the viewport in either the round or the result state.

Run `npm run verify:ui` for the repeatable browser checks behind these invariants. Use `npm run verify:ui:artifacts` to also save the audited browser state in `.ui-audit/` for visual inspection.
