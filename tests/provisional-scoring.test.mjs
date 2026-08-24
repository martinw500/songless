import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createScorer,
  difficultyFor,
  difficultyWeights,
  provisionalDifficultyFor,
  provisionalDifficultyWeights,
} from "../scripts/provisional-scoring.mjs";

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

test("unreviewed intros keep waveform audibility at ten percent", () => {
  assert.deepEqual(provisionalDifficultyWeights, {
    audibilityProxy: 0.10,
    streamReach: 0.50,
    audienceFamiliarity: 0.20,
    genZRelevance: 0.15,
    longevity: 0.05,
  });
  assert.equal(provisionalDifficultyFor(78.1), "easy");
  assert.equal(provisionalDifficultyFor(78), "medium");
  assert.equal(provisionalDifficultyFor(72.8), "medium");
  assert.equal(provisionalDifficultyFor(72.7), "hard");
  assert.equal(provisionalDifficultyFor(68.7), "hard");
  assert.equal(provisionalDifficultyFor(68.6), "expert");
  assert.equal(provisionalDifficultyFor(66.8), "expert");
  assert.equal(provisionalDifficultyFor(66.7), "impossible");

  const scoreSong = createScorer({ tracks: [] }, { songs: [] });
  const result = scoreSong({
    id: "unreviewed-example",
    title: "Unreviewed Example",
    artist: "Test Artist",
    familiarity: 75,
    introRecognition: null,
    scores: {
      audienceRecognition: 80,
      currentCirculation: 60,
      broaderVisibility: 80,
      longevity: 40,
    },
  });
  assert.equal(result.introScoreMethod, "waveform_audibility_proxy_low_weight");
  assert.equal(result.introRecognition, 50);
  assert.equal(result.audienceFamiliarityScore, 80);
  assert.equal(result.easeScore, 73.7);
  assert.equal(result.difficulty, "medium");
});

test("reviewed iconic childhood hits are not demoted by waveform proxies", () => {
  const candidates = JSON.parse(readFileSync("data/song-candidates.json", "utf8")).songs;
  const longlist = JSON.parse(readFileSync("data/song-longlist.json", "utf8"));
  const features = JSON.parse(readFileSync("data/intro-audio-features.json", "utf8"));
  const song = candidates.find((candidate) => candidate.id === "katy-perry-california-gurls");
  const result = createScorer(longlist, features)(song);

  assert.equal(result.introScoreMethod, "reviewed");
  assert.equal(result.introRecognition, 96);
  assert.equal(result.easeScore, 83.3);
  assert.equal(result.difficulty, "easy");
});
