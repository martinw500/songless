import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScorer } from "./provisional-scoring.mjs";
import { automaticStartMs } from "./media-start-normalization.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const candidates = readJson("data/song-candidates.json").songs;
const catalog = readJson("public/catalog.json");
const features = readJson("data/intro-audio-features.json");
const longlist = readJson("data/song-longlist.json");
const overrides = readJson("data/media-start-overrides.json").songs;
const errors = [];
const warnings = [];
const difficulties = ["easy", "medium", "hard", "expert", "impossible"];
const minimumSongsPerDifficulty = 50;
const counts = Object.fromEntries(difficulties.map((difficulty) => [difficulty, 0]));

function uniqueMap(rows, label) {
  const result = new Map();
  for (const row of rows) {
    if (!row?.id) {
      errors.push(`${label} row is missing an id.`);
      continue;
    }
    if (result.has(row.id)) errors.push(`${label} contains duplicate id ${row.id}.`);
    result.set(row.id, row);
  }
  return result;
}

const candidateById = uniqueMap(candidates, "Candidates");
const catalogById = uniqueMap(catalog, "Catalogue");
const featureById = uniqueMap(features.songs, "Intro features");
const overrideById = uniqueMap(overrides, "Media-start overrides");
const playableCandidates = candidates.filter((song) => song.media?.hostedClueUrl
  && song.media?.hostedFullUrl && Number.isInteger(song.media?.hostedDurationMs));
const scoreSong = createScorer(longlist, features);

if (catalog.length !== playableCandidates.length) {
  errors.push(`Catalogue has ${catalog.length} songs; expected ${playableCandidates.length} hosted candidates.`);
}
if (features.songs.length !== playableCandidates.length) {
  errors.push(`Intro features have ${features.songs.length} rows; expected ${playableCandidates.length}.`);
}

for (const candidate of playableCandidates) {
  const song = catalogById.get(candidate.id);
  const feature = featureById.get(candidate.id);
  if (!song) {
    errors.push(`${candidate.id}: missing from provisional catalogue.`);
    continue;
  }
  if (!feature) errors.push(`${candidate.id}: missing intro waveform features.`);
  if (!difficulties.includes(song.difficulty)) errors.push(`${candidate.id}: invalid difficulty ${song.difficulty}.`);
  else counts[song.difficulty] += 1;
  if (song.audio?.kind !== "hosted"
    || !/^https:\/\//u.test(song.audio.clueSrc ?? "")
    || !/^https:\/\//u.test(song.audio.fullSrc ?? "")
    || song.audio.durationMs !== candidate.media.hostedDurationMs) {
    errors.push(`${candidate.id}: hosted audio URLs or duration disagree with the candidate.`);
  }
  if (song.startAtMs !== (candidate.startAtMs ?? candidate.media.onsetPadMs ?? 30)) {
    errors.push(`${candidate.id}: startAtMs disagrees with the candidate.`);
  }
  if ((song.clueGainDb ?? 0) !== (candidate.clueGainDb ?? 0)) {
    errors.push(`${candidate.id}: clueGainDb disagrees with the candidate.`);
  }
  if (song.startAtMs + 15_000 > song.audio.durationMs) errors.push(`${candidate.id}: start leaves less than 15 seconds.`);
  if (song.clueGainDb !== undefined && (!Number.isFinite(song.clueGainDb) || song.clueGainDb < 0 || song.clueGainDb > 12)) {
    errors.push(`${candidate.id}: clueGainDb must be between 0 and 12.`);
  }
  const expected = scoreSong(candidate);
  for (const key of ["streamReachScore", "genZRelevanceScore", "longevityScore", "recognitionScore", "introRecognition"]) {
    if (song[key] !== expected[key]) errors.push(`${candidate.id}: ${key} is stale; expected ${expected[key]}, found ${song[key]}.`);
  }
  if (song._easeScore !== expected.easeScore || song.difficulty !== expected.difficulty) {
    errors.push(`${candidate.id}: ease/difficulty is stale; expected ${expected.easeScore}/${expected.difficulty}.`);
  }
  if (feature && Number.isFinite(feature.first2SecondsDb)) {
    const effectiveDb = feature.first2SecondsDb + (candidate.clueGainDb ?? 0);
    if (effectiveDb < -38) warnings.push(`${candidate.id}: first two seconds remain quiet at ${effectiveDb.toFixed(1)} dB.`);
  }
  const expectedAutomaticStartMs = automaticStartMs(candidate, feature, overrideById.has(candidate.id));
  if (expectedAutomaticStartMs !== null) {
    errors.push(`${candidate.id}: media-start auto-normalization was not applied; expected ${expectedAutomaticStartMs}ms.`);
  }
}

for (const song of catalog) if (!candidateById.has(song.id)) errors.push(`${song.id}: catalogue song has no candidate.`);
for (const override of overrides) {
  const candidate = candidateById.get(override.id);
  if (!candidate) errors.push(`${override.id}: media-start override has no candidate.`);
  else if (candidate.startAtMs !== override.startAtMs || (candidate.clueGainDb ?? 0) !== (override.clueGainDb ?? 0)) {
    errors.push(`${override.id}: documented media-start override has not been applied.`);
  }
}
for (const difficulty of difficulties) {
  if (counts[difficulty] < minimumSongsPerDifficulty) {
    errors.push(`Provisional catalogue needs at least ${minimumSongsPerDifficulty} ${difficulty} songs; found ${counts[difficulty]}.`);
  }
}

console.log(`Provisional catalogue: ${catalog.length} songs; ${difficulties.map((difficulty) => `${difficulty}=${counts[difficulty]}`).join(", ")}.`);
console.log(`Waveform features: ${features.songs.length}; documented media overrides: ${overrideById.size}.`);
if (warnings.length) {
  console.log(`Warnings (${warnings.length}):`);
  for (const warning of warnings) console.log(`- ${warning}`);
}
if (errors.length) {
  console.error(`Errors (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Provisional catalogue audit passed.");
}
