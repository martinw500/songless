import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const candidates = JSON.parse(readFileSync("data/song-candidates.json", "utf8")).songs;
const catalog = JSON.parse(readFileSync("public/catalog.json", "utf8"));
const overrides = JSON.parse(readFileSync("data/artwork-source-overrides.json", "utf8")).overrides;
const byId = new Map(candidates.map((song) => [song.id, song]));
const catalogById = new Map(catalog.map((song) => [song.id, song]));

test("reviewed artwork overrides keep original release metadata and cache-busted R2 art", () => {
  const expected = new Map([
    ["maroon-5-payphone", "Overexposed (Deluxe)"],
    ["ed-sheeran-shape-of-you", "÷ (Deluxe)"],
    ["gnarls-barkley-crazy", "St. Elsewhere"],
  ]);

  for (const [id, album] of expected) {
    const override = overrides.find((entry) => entry.id === id);
    const candidate = byId.get(id);
    const liveSong = catalogById.get(id);
    assert.ok(override?.reason);
    assert.match(override.artworkMd5, /^[a-f0-9]{32}$/u);
    assert.equal(candidate.album, album);
    assert.equal(liveSong.album, album);
    assert.match(candidate.media.artworkUrl, new RegExp(`^https://[^/]+/artwork/${id}\\.jpg\\?v=spotify-${override.artworkMd5.slice(0, 12)}$`, "u"));
    assert.equal(liveSong.artwork, candidate.media.artworkUrl);
  }
});

test("unreviewed candidates cannot retain unrelated compilation presentation metadata", () => {
  const unrelatedCompilationPattern = /\b(?:sing[ -]?along|karaoke|made famous|in the style of|sound[ -]?alike|top motivation|workout|fitness|kids bop|\d+ greatest .*songs)\b/iu;
  const reviewed = new Set(overrides.map((entry) => entry.id));
  const offenders = candidates.filter((song) => unrelatedCompilationPattern.test(song.album ?? "") && !reviewed.has(song.id));
  assert.deepEqual(offenders.map((song) => `${song.id}: ${song.album}`), []);
});
