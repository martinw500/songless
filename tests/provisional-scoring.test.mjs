import assert from "node:assert/strict";
import test from "node:test";
import { createScorer, difficultyFor, difficultyWeights } from "../scripts/provisional-scoring.mjs";

test("fixed difficulty thresholds cover every calibrated boundary", () => {
  assert.equal(difficultyFor(100), "easy");
  assert.equal(difficultyFor(82.6), "easy");
  assert.equal(difficultyFor(82.5), "medium");
  assert.equal(difficultyFor(79.2), "medium");
  assert.equal(difficultyFor(79.1), "hard");
  assert.equal(difficultyFor(75.9), "hard");
  assert.equal(difficultyFor(75.8), "expert");
  assert.equal(difficultyFor(72), "expert");
  assert.equal(difficultyFor(71.9), "impossible");
});

test("difficulty weights keep Gen-Z relevance at fifteen percent", () => {
  assert.deepEqual(difficultyWeights, {
    introRecognition: 0.45,
    streamReach: 0.35,
    genZRelevance: 0.15,
    longevity: 0.05,
  });

  const scoreSong = createScorer({ tracks: [] }, { songs: [] });
  const result = scoreSong({
    id: "weighted-example",
    title: "Weighted Example",
    artist: "Test Artist",
    introRecognition: 70,
    scores: {
      audienceRecognition: 80,
      currentCirculation: 60,
      broaderVisibility: 90,
      longevity: 40,
    },
  });

  assert.equal(result.streamReachScore, 90);
  assert.equal(result.genZRelevanceScore, 71);
  assert.equal(result.longevityScore, 40);
  assert.equal(result.easeScore, 75.7);
  assert.equal(result.difficulty, "expert");
});
