import assert from "node:assert/strict";
import test from "node:test";
import { sortCandidatesBillionFirst } from "../scripts/song-priority.mjs";

test("source resolution prioritizes billion-stream rank ahead of seed-file order", () => {
  const candidates = [
    { id: "global-seed", title: "Global Seed", aliases: [] },
    { id: "second-billion", title: "Second Hit", aliases: [] },
    { id: "first-billion", title: "First Hit", aliases: [] },
  ];
  const longlist = {
    tracks: [
      { sourceRank: 2, title: "Second Hit (feat. Guest)", signals: ["billion_streams"] },
      { sourceRank: 1, title: "First Hit", signals: ["billion_streams"] },
    ],
  };

  assert.deepEqual(
    sortCandidatesBillionFirst(candidates, longlist).map((candidate) => candidate.id),
    ["first-billion", "second-billion", "global-seed"],
  );
});
