import assert from "node:assert/strict";
import test from "node:test";
import { difficultyFor } from "../scripts/provisional-scoring.mjs";

test("fixed difficulty thresholds cover every calibrated boundary", () => {
  assert.equal(difficultyFor(100), "easy");
  assert.equal(difficultyFor(85), "easy");
  assert.equal(difficultyFor(84.9), "medium");
  assert.equal(difficultyFor(82.5), "medium");
  assert.equal(difficultyFor(82.4), "hard");
  assert.equal(difficultyFor(80), "hard");
  assert.equal(difficultyFor(79.9), "expert");
  assert.equal(difficultyFor(75), "expert");
  assert.equal(difficultyFor(74.9), "impossible");
});
