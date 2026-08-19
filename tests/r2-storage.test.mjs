import assert from "node:assert/strict";
import test from "node:test";
import { assertWithinR2Budget, projectedBucketBytes } from "../scripts/r2-storage.mjs";

test("R2 projection counts the whole bucket and replaces existing object sizes", () => {
  const existing = new Map([
    ["unrelated.bin", 2_000],
    ["audio/full/song.mp3", 1_000],
  ]);
  const result = projectedBucketBytes(existing, [
    { key: "audio/full/song.mp3", size: 1_500 },
    { key: "audio/clues/song.mp3", size: 200 },
  ]);
  assert.deepEqual(result, { existingBytes: 3_000, projectedBytes: 3_700 });
});

test("R2 budget rejects a batch before upload and caps configuration below 10 GB", () => {
  assert.doesNotThrow(() => assertWithinR2Budget(8_499_999_999, 8_500_000_000));
  assert.throws(() => assertWithinR2Budget(8_500_000_001, 8_500_000_000), /refused before writing/u);
  assert.throws(() => assertWithinR2Budget(1, 9_000_000_001), /no greater than 9000000000/u);
});
