import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { automaticStartMs, configuredStartMs } from "./media-start-normalization.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const overrideFile = path.join(root, "data", "media-start-overrides.json");
const featureFile = path.join(root, "data", "intro-audio-features.json");
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const overrideRoot = JSON.parse(readFileSync(overrideFile, "utf8"));
const overrides = overrideRoot.songs;
const features = JSON.parse(readFileSync(featureFile, "utf8")).songs;
const candidates = new Map(candidateRoot.songs.map((song) => [song.id, song]));
const featureById = new Map(features.map((feature) => [feature.id, feature]));
const overrideById = new Map(overrides.map((override) => [override.id, override]));
const overrideIds = new Set(overrides.map((override) => override.id));
const verbose = process.argv.includes("--verbose");
const dryRun = process.argv.includes("--dry-run");
let changedCount = 0;
let automaticCount = 0;
let staleFeatureCount = 0;
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

// A clue window that measures as silent is an audible defect, so the gate
// corrects documented overrides too. Their clueGainDb decisions are preserved.
for (const song of candidateRoot.songs) {
  const feature = featureById.get(song.id);
  const previousStartMs = configuredStartMs(song);
  if (feature?.clueWindowStatus && feature.clueWindowStartMs !== previousStartMs) {
    staleFeatureCount += 1;
    console.warn(`${song.id}: feature row measured at ${feature.clueWindowStartMs}ms but start is ${previousStartMs}ms; re-run audit:media-starts.`);
    continue;
  }
  const normalizedStartMs = automaticStartMs(song, feature, overrideIds.has(song.id));
  if (normalizedStartMs === null) continue;
  automaticCount += 1;
  const reasons = feature.clueWindowReasons?.join("/") ?? "clue-window-silent";
  console.log(`${song.id}: clue window silent (${reasons}); ${previousStartMs}ms -> ${normalizedStartMs}ms measured music onset`);
  if (dryRun) continue;
  song.startAtMs = normalizedStartMs;
  const override = overrideById.get(song.id);
  if (override) {
    override.startAtMs = normalizedStartMs;
    override.reason = "Measured music onset; the previous start opened the shortest clue on inaudible audio.";
  }
}

// One override per line, matching the reviewed file's existing shape so a
// handful of corrections does not reformat all 311 entries.
function formatOverrides(root) {
  const rows = root.songs.map((song) => {
    const parts = [`"id": ${JSON.stringify(song.id)}`, `"startAtMs": ${song.startAtMs}`];
    if (song.clueGainDb !== undefined) parts.push(`"clueGainDb": ${song.clueGainDb}`);
    parts.push(`"reason": ${JSON.stringify(song.reason)}`);
    return `    { ${parts.join(", ")} }`;
  });
  return `{\n  "version": ${JSON.stringify(root.version)},\n  "notes": ${JSON.stringify(root.notes)},\n  "songs": [\n${rows.join(",\n")}\n  ]\n}\n`;
}

if (dryRun) {
  console.log(`Dry run: ${automaticCount} song(s) would move to their measured music onset; ${staleFeatureCount} stale feature row(s).`);
} else {
  writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
  writeFileSync(overrideFile, formatOverrides(overrideRoot), "utf8");
  console.log(`Validated ${overrides.length} documented media-start overrides; updated ${changedCount} override(s), corrected ${automaticCount} silent clue window(s), skipped ${staleFeatureCount} stale feature row(s).`);
}
