import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selectionFile = path.join(root, "data", "billion-media-selection.local.json");
const durationFile = path.join(root, "data", "billion-source-duration-audit.local.json");
const fingerprintFile = path.join(root, "data", "canonical-fingerprint-audit.local.json");
const preparedManifestFile = path.join(root, "private-media", "r2", "manifest.json");
const outputFile = path.join(root, "data", "billion-media-final.local.json");
const target = Number(process.argv.find((value) => value.startsWith("--target="))?.split("=")[1] ?? 200);
if (!Number.isInteger(target) || target < 1) throw new Error("--target must be a positive integer.");

const selection = JSON.parse(readFileSync(selectionFile, "utf8"));
if (!existsSync(durationFile)) throw new Error(`Missing duration audit: ${path.relative(root, durationFile)}`);
const durationReport = JSON.parse(readFileSync(durationFile, "utf8"));
const fingerprintReport = existsSync(fingerprintFile)
  ? JSON.parse(readFileSync(fingerprintFile, "utf8"))
  : { songs: [] };
const preparedIds = new Set(
  existsSync(preparedManifestFile)
    ? JSON.parse(readFileSync(preparedManifestFile, "utf8")).songs.map((song) => song.id)
    : [],
);

const durationById = new Map(durationReport.songs.map((song) => [song.id, song]));
const fingerprintById = new Map(fingerprintReport.songs.map((song) => [song.id, song]));

const excluded = [];
const eligible = [];

for (const row of selection.selected) {
  const duration = durationById.get(row.id);
  const fingerprint = fingerprintById.get(row.id);

  if (!duration || duration.status === "missing_source") {
    excluded.push({ id: row.id, reason: "missing_source", sourceRank: row.sourceRank });
    continue;
  }
  if (duration.status !== "pass") {
    excluded.push({ id: row.id, reason: `duration_${duration.status}`, sourceRank: row.sourceRank });
    continue;
  }
  if (!preparedIds.has(row.id)) {
    excluded.push({ id: row.id, reason: "not_prepared", sourceRank: row.sourceRank });
    continue;
  }

  if (row.fingerprintRequired) {
    if (!fingerprint || fingerprint.status !== "canonical_match") {
      excluded.push({
        id: row.id,
        reason: fingerprint ? `fingerprint_${fingerprint.status}` : "fingerprint_required_missing",
        distance: fingerprint?.distance ?? null,
        sourceRank: row.sourceRank,
      });
      continue;
    }
  } else if (fingerprint) {
    // Preview fetch failures are not recording proof against a direct/provenance source.
    // Only acoustic mismatches and wrong-album references exclude a direct row.
    if (fingerprint.status === "recording_mismatch"
      || fingerprint.status === "probable_match"
      || fingerprint.status === "reference_album_mismatch"
      || fingerprint.status === "reference_rejected_edition"
      || fingerprint.status === "reference_conflict") {
      excluded.push({
        id: row.id,
        reason: `fingerprint_${fingerprint.status}`,
        distance: fingerprint.distance ?? null,
        sourceRank: row.sourceRank,
      });
      continue;
    }
  }

  eligible.push({
    id: row.id,
    sourceRank: row.sourceRank,
    fingerprintRequired: Boolean(row.fingerprintRequired),
    fingerprintStatus: fingerprint?.status ?? null,
    distance: fingerprint?.distance ?? null,
  });
}

eligible.sort((left, right) => left.sourceRank - right.sourceRank);
const finalRows = eligible.slice(0, target);
const reserveNeeded = Math.max(0, target - finalRows.length);

const report = {
  generatedAt: new Date().toISOString(),
  target,
  eligibleCount: eligible.length,
  finalCount: finalRows.length,
  reserveNeeded,
  counts: {
    excluded: excluded.length,
    gatedFinal: finalRows.filter((row) => row.fingerprintRequired).length,
    directFinal: finalRows.filter((row) => !row.fingerprintRequired).length,
  },
  finalIds: finalRows.map((row) => row.id),
  final: finalRows,
  excluded,
};
writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Final selection: ${finalRows.length}/${target} (eligible=${eligible.length}, excluded=${excluded.length}, reserveNeeded=${reserveNeeded}).`);
console.log(`Report: ${path.relative(root, outputFile)}`);
if (reserveNeeded > 0) {
  console.warn(`SHORTFALL: need ${reserveNeeded} more verified song(s) from the gated reserve.`);
  process.exitCode = 2;
}
