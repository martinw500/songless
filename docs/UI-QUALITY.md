# UI quality and motion

This document is the acceptance guide for Songless interface work. The goal is a game that feels deliberate and responsive, not merely functional.

## Visual hierarchy

The center game card is the primary surface. Difficulty controls and settings support it without competing with the play control or result reveal. Colors follow the selected difficulty during play; loss uses a red wash and win uses the selected accent with brighter green celebration details.

The play glyph, skip icon, settings icons, and side actions use SVG artwork so their edges remain complete and smooth at every size. Optical centering is judged from the rendered shape, especially for asymmetric play and skip symbols.

## Stage configuration

The stage pills toggle the durations used by the round. The timeline keeps a stable node for every available duration and animates each enabled segment between zero and its weighted width. This lets neighboring segments slide into their new positions when a duration is added or removed.

Changing the stage configuration restarts the current round, stops active audio, updates the displayed time, and saves the selection to local storage. At least one duration remains enabled.

## Result choreography

The visible result group—not an oversized invisible wrapper—is centered in the game card.

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
- Trigger both a win and loss. Confirm the visible artwork-to-stamp group is optically centered and no result content is clipped.
- Observe the transition rather than only its final frame. Win confetti should be visible but contained, and the stamp should be the final emphasis.
- Check a narrow viewport and the reduced-motion media mode.
