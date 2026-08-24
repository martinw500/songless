import assert from "node:assert/strict";
import test from "node:test";
import { automaticStartMs } from "../scripts/media-start-normalization.mjs";

test("undocumented short-clue dead zones advance to sustained audio", () => {
  const song = { startAtMs: 50, media: {} };
  assert.equal(automaticStartMs(song, { firstAudibleMs: 200 }, false), 200);
});

test("sub-100ms gaps and documented musical fades stay unchanged", () => {
  const song = { startAtMs: 125, media: {} };
  assert.equal(automaticStartMs(song, { firstAudibleMs: 200 }, false), null);
  assert.equal(automaticStartMs(song, { firstAudibleMs: 500 }, true), null);
});
