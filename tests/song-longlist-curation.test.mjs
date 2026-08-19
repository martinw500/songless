import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const longlist = readJson("data/song-longlist.json");
const current = readJson("data/song-longlist-decisions.json");
const finalized = readJson("data/song-longlist-finalized-pass-4.json");
const reviewedKeeps = readJson("data/song-longlist-keeps.json");
const nextReview = readFileSync(path.join(root, "data/song-review-next.txt"), "utf8");

function normalized(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findTrack(title, artist) {
  return longlist.tracks.find(
    (track) => normalized(track.title) === normalized(title)
      && normalized(track.artist).includes(normalized(artist)),
  );
}

test("founder-protected and restored songs remain active", () => {
  const protectedTracks = [
    ["Cyanide", "Daniel Caesar"],
    ["Streetcar", "Daniel Caesar"],
    ["How You Like That", "BLACKPINK"],
    ["Boyfriend (With Social House)", "Ariana Grande"],
    ["Kings & Queens", "Ava Max"],
    ["10,000 Hours (With Justin Bieber)", "Dan + Shay"],
    ["No Pole", "Don Toliver"],
    ["Chest Pain (I Love)", "Malcolm Todd"],
    ["Love Me Not", "Ravyn Lenae"],
    ["Like That", "Future"],
    ["Family Ties (With Kendrick Lamar)", "Baby Keem"],
    ["Party Rock Anthem", "LMFAO"],
    ["Lonely", "Akon"],
    ["Airplanes (Feat. Hayley Williams Of Paramore)", "B.o.B"],
  ];
  for (const [title, artist] of protectedTracks) {
    const track = findTrack(title, artist);
    assert.ok(track, `${title} by ${artist} must remain in the longlist.`);
    assert.notEqual(track.reviewStatus, "rejected", `${title} by ${artist} must remain active.`);
  }
});

test("promoted childhood icons no longer appear in the next-review queue", () => {
  for (const title of ["Party Rock Anthem", "Lonely", "Airplanes", "Like That", "Family Ties"]) {
    assert.ok(!nextReview.includes(`${title} —`), `${title} should be promoted out of review-next.`);
  }
});

test("reviewed keeps are shortlisted and only uncertain tracks remain in review-next", () => {
  assert.equal(reviewedKeeps.tracks.length, longlist.counts.reviewedKeeps);
  for (const keep of reviewedKeeps.tracks) {
    const track = findTrack(keep.title, keep.artist);
    assert.ok(track, `${keep.title} by ${keep.artist} must remain in the longlist.`);
    assert.equal(track.reviewStatus, "shortlisted", `${keep.title} must be shortlisted.`);
    assert.ok(track.signals.includes("reviewed_keep"), `${keep.title} must carry reviewed_keep.`);
    assert.ok(!nextReview.includes(`${keep.title} —`), `${keep.title} must not remain in review-next.`);
  }
  const reviewLines = nextReview.split(/\r?\n/u).filter((line) => /^\d{4}\./u.test(line));
  assert.equal(reviewLines.length, 0);
});

test("explicitly removed songs stay out of the generated longlist", () => {
  for (const title of ["Burning Blue", "KEHLANI", "WHATCHU KNO ABOUT ME", "SUGAR ON MY TONGUE", "Imma Be", "My Humps", "Glamorous", "Fergalicious", "London Bridge"]) {
    assert.equal(findTrack(title, ""), undefined, `${title} must not be regenerated.`);
  }
});

test("finalized pass is excluded while current decisions stay reversible", () => {
  assert.equal(finalized.trackDecisions.length, 93);
  for (const decision of finalized.trackDecisions) {
    assert.equal(findTrack(decision.title, decision.artist), undefined, `${decision.title} should be finalized out.`);
  }
  assert.ok(current.trackDecisions.length > 0);
  assert.equal(longlist.counts.rejected, current.trackDecisions.length);
  for (const decision of current.trackDecisions) {
    const track = findTrack(decision.title, decision.artist);
    assert.ok(track, `${decision.title} should remain visible in the reversible review batch.`);
    assert.equal(track.reviewStatus, "rejected");
  }
});

test("latest recognition batch is present and supported", () => {
  const recent = [
    ["Stateside + Zara Larsson", "PinkPantheress"],
    ["So Easy (To Fall In Love)", "Olivia Dean"],
    ["Die On This Hill", "SIENNA SPIRO"],
    ["White Keys", "Dominic Fike"],
    ["hate that i made you love me", "Ariana Grande"],
    ["Babydoll", "Dominic Fike"],
    ["The Color Violet", "Tory Lanez"],
    ["The Spins", "Mac Miller"],
    ["Ribs", "Lorde"],
    ["Party Rock Anthem", "LMFAO"],
    ["Lonely", "Akon"],
    ["Airplanes (Feat. Hayley Williams Of Paramore)", "B.o.B"],
    ["Breakin' Dishes", "Rihanna"],
    ["Rude Boy", "Rihanna"],
    ["Drop Dead", "Olivia Rodrigo"],
    ["Oh Yeah?", "Steve Lacy"],
    ["Darling, I", "Tyler, The Creator"],
  ];
  for (const [title, artist] of recent) {
    const track = findTrack(title, artist);
    assert.ok(track, `${title} by ${artist} must be present.`);
    assert.ok(track.signals.includes("founder_pick"), `${title} must carry a recognition signal.`);
  }
});
