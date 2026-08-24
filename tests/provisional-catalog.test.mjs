import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const candidates = JSON.parse(readFileSync("data/song-candidates.json", "utf8")).songs;
const catalog = JSON.parse(readFileSync("public/catalog.json", "utf8"));
const catalogById = new Map(catalog.map((song) => [song.id, song]));

test("rejected candidates cannot remain in the provisional game catalogue", () => {
  const rejectedIds = candidates.filter((song) => song.reviewStatus === "rejected").map((song) => song.id);
  assert.ok(rejectedIds.includes("indila-derniere-danse"));
  for (const id of rejectedIds) assert.equal(catalogById.has(id), false, `${id} remained playable`);
});

test("Locked Out of Heaven skips its reported opening dead zone", () => {
  assert.equal(catalogById.get("bruno-mars-locked-out-of-heaven")?.startAtMs, 2100);
});
