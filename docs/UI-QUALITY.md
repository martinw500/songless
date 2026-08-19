# UI quality and motion

This document is the acceptance guide for Songless interface work. The goal is a game that feels deliberate and responsive, not merely functional.

## Visual hierarchy

The center game card is the primary surface. Difficulty controls and settings support it without competing with the play control or result reveal. Colors follow the selected difficulty during play; loss uses a red wash and win uses the selected accent with brighter green celebration details.

The play glyph, skip icon, settings icons, and side actions use SVG artwork so their edges remain complete and smooth at every size. Optical centering is judged from the rendered shape, especially for asymmetric play and skip symbols.

## Stage configuration

The stage pills toggle the durations used by the round. The timeline keeps a stable node for every available duration and animates each enabled segment between zero and its weighted width. This lets neighboring segments slide into their new positions when a duration is added or removed.

Timeline meaning is split into three independent layers. The unlocked range is a continuous translucent accent from zero through the current clue endpoint. The actually played range is an opaque accent from zero through the playback head. Segment borders sit above both fills and remain visible in every state. A narrow glow at the opaque range edge is the live playback head; there is no static current-stage cursor.

Changing the stage configuration stops active audio and saves the selection to local storage. Removing the current duration selects the next longer enabled duration (falling back to the longest remaining duration). Adding a duration earlier than the current duration makes the newly added duration current, preventing it from being painted as an already-passed clue. At least one duration remains enabled.

Stage configuration is pre-round setup. The first Play click locks all stage pills for the remainder of that song, including after skips, wrong guesses, completed clues, and result reveal. A full round reset or new song unlocks them again. Locked pills retain enough color to communicate the chosen configuration but have no hover/press response.

Skip itself is silent. Advancing from 2 to 8 only unlocks the translucent 2-8 interval and leaves the completed 0-2 range opaque. The next Play runs song time 2 through 8 while continuing the opaque layer from the 2-second boundary. Once that continuation reaches 8, the following Play begins the cumulative 0-8 replay and restarts the opaque sweep from the far-left edge. Pausing freezes both audio and the opaque sweep at the exact elapsed timestamp; the next Play resumes from that point.

Skipping or submitting a wrong answer silently unlocks the next interval without starting it. The previously completed range remains opaque, the newly available interval receives translucent accent, and its later playback edge has no extra cursor or decorative blip. Routine instructions such as “Skipped” or “You now have 2 seconds” never appear over the player. The default stages are 0.1, 0.5, 2, 8, and 15 seconds; 0.01 seconds is an optional setting.

## Result choreography

The visible result group—not an oversized invisible wrapper—is centered in the game card.

Entering either win or loss stops clue playback and immediately continues the same track from the furthest timestamp actually reached. Starting a new round, rerolling, or changing difficulty stops that reveal playback.

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
- Observe the transition rather than only its final frame. Win confetti should be visible but contained, and the stamp should be the final emphasis.
- Check a narrow viewport and the reduced-motion media mode.

Run `npm run verify:ui` for the repeatable browser checks behind these invariants. Use `npm run verify:ui:artifacts` to also save the audited browser state in `.ui-audit/` for visual inspection.
