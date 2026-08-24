import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { automaticStartMs } from "./media-start-normalization.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const overrideFile = path.join(root, "data", "media-start-overrides.json");
const featureFile = path.join(root, "data", "intro-audio-features.json");
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const overrides = JSON.parse(readFileSync(overrideFile, "utf8")).songs;
const features = JSON.parse(readFileSync(featureFile, "utf8")).songs;
const candidates = new Map(candidateRoot.songs.map((song) => [song.id, song]));
const featureById = new Map(features.map((feature) => [feature.id, feature]));
const overrideIds = new Set(overrides.map((override) => override.id));
const verbose = process.argv.includes("--verbose");
let changedCount = 0;
let automaticCount = 0;
const duplicateOverrideIds = overrides
  .map((override) => override.id)
  .filter((id, index, ids) => ids.indexOf(id) !== index);
if (duplicateOverrideIds.length > 0) {
  throw new Error(`Duplicate media-start override ids: ${[...new Set(duplicateOverrideIds)].join(", ")}`);
}

for (const override of overrides) {
  const song = candidates.get(override.id);
  if (!song) throw new Error(`Unknown media-start override id: ${override.id}`);
  if (!Number.isInteger(override.startAtMs) || override.startAtMs < 0) throw new Error(`Invalid startAtMs for ${override.id}`);
  if (override.clueGainDb !== undefined
    && (!Number.isFinite(override.clueGainDb) || override.clueGainDb < 0 || override.clueGainDb > 12)) {
    throw new Error(`Invalid clueGainDb for ${override.id}`);
  }
  const changed = song.startAtMs !== override.startAtMs
    || (song.clueGainDb ?? undefined) !== (override.clueGainDb ?? undefined);
  song.startAtMs = override.startAtMs;
  if (override.clueGainDb === undefined) delete song.clueGainDb;
  else song.clueGainDb = override.clueGainDb;
  if (changed) changedCount += 1;
  if (changed || verbose) {
    console.log(`${override.id}: start=${override.startAtMs}ms${override.clueGainDb ? ` gain=+${override.clueGainDb}dB` : ""}`);
  }
}

for (const song of candidateRoot.songs) {
  const normalizedStartMs = automaticStartMs(song, featureById.get(song.id), overrideIds.has(song.id));
  if (normalizedStartMs === null) continue;
  const previousStartMs = song.startAtMs ?? song.media?.onsetPadMs ?? 30;
  song.startAtMs = normalizedStartMs;
  automaticCount += 1;
  console.log(`${song.id}: auto-normalized ${previousStartMs}ms -> ${normalizedStartMs}ms sustained onset`);
}

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`Validated ${overrides.length} documented media-start overrides; updated ${changedCount} override(s), auto-normalized ${automaticCount} candidate(s).`);
