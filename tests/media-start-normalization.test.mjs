import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticStartMs,
  clueWindowIsAudible,
  clueWindowPass,
  clueWindowSilent,
  configuredStartMs,
  evaluateClueWindow,
  playbackGainFromBodyDb,
} from "../scripts/media-start-normalization.mjs";

const bodyDb = -20;

test("a clue whose sub-windows all reach the song's loudness passes", () => {
  const verdict = evaluateClueWindow({ bodyDb, subWindowDbs: [-24, -22, -21, -20, -20] });
  assert.equal(verdict.status, clueWindowPass);
  assert.equal(verdict.audibleSubWindows, 5);
});

test("a single quiet sub-window is a note attack, not a defect", () => {
  const verdict = evaluateClueWindow({ bodyDb, subWindowDbs: [-60, -22, -21, -20, -20] });
  assert.equal(verdict.status, clueWindowPass);
  assert.equal(verdict.audibleSubWindows, 4);
});

test("a clue that only carries energy in its tail is silent", () => {
  const verdict = evaluateClueWindow({ bodyDb, subWindowDbs: [-60, -55, -52, -48, -20] });
  assert.equal(verdict.status, clueWindowSilent);
  assert.deepEqual(verdict.reasons, ["clue-mostly-inaudible"]);
});

test("digital zeros in the lead-in fail however the rest of the clue measures", () => {
  const verdict = evaluateClueWindow({
    bodyDb,
    subWindowDbs: [-24, -22, -21, -20, -20],
    leadHasDigitalSilence: true,
  });
  assert.equal(verdict.status, clueWindowSilent);
  assert.deepEqual(verdict.reasons, ["digital-silence-lead-in"]);
});

test("quiet masters are raised toward the playback loudness target", () => {
  assert.equal(playbackGainFromBodyDb(-28.9), 12);
  assert.equal(playbackGainFromBodyDb(-12.7), 0);
  assert.equal(playbackGainFromBodyDb(-20), 4);
  assert.equal(playbackGainFromBodyDb(null), 0);
});

test("clue-only gain is credited against the audibility threshold", () => {
  const quiet = { bodyDb, subWindowDbs: [-52, -50, -49, -48, -47] };
  assert.equal(evaluateClueWindow(quiet).status, clueWindowSilent);
  assert.equal(evaluateClueWindow({ ...quiet, clueGainDb: 6 }).status, clueWindowPass);
});

test("songs without a measured body level are not gated", () => {
  assert.equal(evaluateClueWindow({ bodyDb: null, subWindowDbs: [-90, -90, -90, -90, -90] }).status, clueWindowPass);
});

test("the onset threshold is stricter than the gate, leaving a seek margin", () => {
  const marginal = [-45, -44, -43, -42, -41];
  assert.equal(evaluateClueWindow({ bodyDb, subWindowDbs: marginal }).status, clueWindowPass);
  assert.equal(clueWindowIsAudible(marginal, bodyDb), false);
  assert.equal(clueWindowIsAudible([-38, -37, -36, -35, -34], bodyDb), true);
});

test("a passing clue window leaves the configured start alone", () => {
  const song = { startAtMs: 250, media: {} };
  assert.equal(automaticStartMs(song, { clueWindowStatus: clueWindowPass, musicOnsetMs: 390 }, false), null);
});

test("a silent clue window corrects the start even for a documented override", () => {
  const song = { startAtMs: 250, media: {} };
  const feature = { clueWindowStatus: clueWindowSilent, musicOnsetMs: 390 };
  assert.equal(automaticStartMs(song, feature, true), 390);
  assert.equal(automaticStartMs(song, feature, false), 390);
});

test("a start already at the measured onset needs no correction", () => {
  const song = { startAtMs: 390, media: {} };
  assert.equal(automaticStartMs(song, { clueWindowStatus: clueWindowSilent, musicOnsetMs: 390 }, false), null);
});

test("a deliberately late start is never dragged backwards", () => {
  const hookStart = { startAtMs: 5450, media: {} };
  assert.equal(automaticStartMs(hookStart, { clueWindowStatus: clueWindowSilent, musicOnsetMs: 110 }, false), null);
});

test("a silent clue window without a measured onset is left for review", () => {
  const song = { startAtMs: 250, media: {} };
  assert.equal(automaticStartMs(song, { clueWindowStatus: clueWindowSilent, musicOnsetMs: null }, false), null);
});

test("the configured start falls back to the encoder pad", () => {
  assert.equal(configuredStartMs({ media: { onsetPadMs: 45 } }), 45);
  assert.equal(configuredStartMs({ media: {} }), 30);
  assert.equal(configuredStartMs({ startAtMs: 0, media: { onsetPadMs: 45 } }), 0);
});
