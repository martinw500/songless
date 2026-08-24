import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const longlist = readJson("data/song-longlist.json");
const candidates = readJson("data/song-candidates.json");
const current = readJson("data/song-longlist-decisions.json");
const finalized = readJson("data/song-longlist-finalized-pass-4.json");
const reviewedKeeps = readJson("data/song-longlist-keeps.json");

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
    ["Notion", "The Rare Occasions"],
  ];
  for (const [title, artist] of protectedTracks) {
    const track = findTrack(title, artist);
    assert.ok(track, `${title} by ${artist} must remain in the longlist.`);
    assert.notEqual(track.reviewStatus, "rejected", `${title} by ${artist} must remain active.`);
  }
});

test("reviewed keeps are shortlisted in the active-only longlist", () => {
  assert.equal(reviewedKeeps.tracks.length, longlist.counts.reviewedKeeps);
  for (const keep of reviewedKeeps.tracks) {
    const track = findTrack(keep.title, keep.artist);
    assert.ok(track, `${keep.title} by ${keep.artist} must remain in the longlist.`);
    assert.equal(track.reviewStatus, "shortlisted", `${keep.title} must be shortlisted.`);
    assert.ok(track.signals.includes("reviewed_keep"), `${keep.title} must carry reviewed_keep.`);
  }
});

test("explicitly removed songs stay out of the generated longlist", () => {
  for (const title of ["Burning Blue", "KEHLANI", "WHATCHU KNO ABOUT ME", "SUGAR ON MY TONGUE", "Imma Be", "My Humps", "Glamorous", "Fergalicious", "London Bridge"]) {
    assert.equal(findTrack(title, ""), undefined, `${title} must not be regenerated.`);
  }
});

test("all pruned songs are omitted from the generated longlist", () => {
  assert.ok(finalized.trackDecisions.length >= 90, "The finalized prune archive unexpectedly lost most of its decisions.");
  for (const decision of finalized.trackDecisions) {
    assert.equal(findTrack(decision.title, decision.artist), undefined, `${decision.title} should be finalized out.`);
  }
  assert.equal(longlist.counts.excludedByCurrentDecisions, current.trackDecisions.length);
  for (const decision of current.trackDecisions) {
    assert.equal(findTrack(decision.title, decision.artist), undefined, `${decision.title} should be omitted.`);
  }
});

test("the 120-song media queue follows explicit keep and prune decisions", () => {
  const candidateNames = new Set(candidates.songs.map((song) => `${normalized(song.title)}|${normalized(song.artist)}`));
  assert.ok(candidateNames.has(`${normalized("Notion")}|${normalized("The Rare Occasions")}`));
  assert.ok(candidateNames.has(`${normalized("White Keys")}|${normalized("Dominic Fike")}`));
  for (const decision of current.trackDecisions) {
    assert.ok(!candidateNames.has(`${normalized(decision.title)}|${normalized(decision.artist)}`), `${decision.title} must not remain in the media queue.`);
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
