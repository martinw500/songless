import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const batchFile = path.join(root, "data", "billion-download-batch.local.json");
const sourceFile = path.join(root, "data", "song-download-sources.local.json");
const candidateFile = path.join(root, "data", "song-candidates.json");
const fingerprintFile = path.join(root, "data", "canonical-fingerprint-audit.local.json");
const outputFile = path.join(root, "data", "billion-media-selection.local.json");
const target = Number(process.argv.find((value) => value.startsWith("--target="))?.split("=")[1] ?? 200);
const reserve = Number(process.argv.find((value) => value.startsWith("--reserve="))?.split("=")[1] ?? 50);
if (!Number.isInteger(target) || target < 1 || !Number.isInteger(reserve) || reserve < 0) {
  throw new Error("--target must be positive and --reserve must be non-negative.");
}

function normalize(value = "") {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

const batch = JSON.parse(readFileSync(batchFile, "utf8"));
const sources = JSON.parse(readFileSync(sourceFile, "utf8")).songs;
const candidates = JSON.parse(readFileSync(candidateFile, "utf8")).songs;
const fingerprints = existsSync(fingerprintFile)
  ? JSON.parse(readFileSync(fingerprintFile, "utf8")).songs : [];
const candidateById = new Map(candidates.map((song) => [song.id, song]));
const fingerprintById = new Map(fingerprints.map((song) => [song.id, song]));
const rankById = new Map(batch.selected.map((song) => [song.id, song.sourceRank]));
const eligible = sources.filter((source) => source.url && rankById.has(source.id)).map((source) => {
  const candidate = candidateById.get(source.id);
  const fingerprint = fingerprintById.get(source.id);
  const confirmedMismatch = fingerprint?.status === "recording_mismatch"
    && fingerprint.canonicalAlbum && candidate?.album
    && normalize(fingerprint.canonicalAlbum) === normalize(candidate.album);
  return {
    id: source.id,
    sourceRank: rankById.get(source.id),
    fingerprintRequired: Boolean(source.youtube?.requiresCanonicalFingerprint),
    confirmedMismatch,
  };
}).filter((song) => !song.confirmedMismatch)
  .sort((left, right) => left.sourceRank - right.sourceRank);

const direct = eligible.filter((song) => !song.fingerprintRequired);
const gated = eligible.filter((song) => song.fingerprintRequired);
const desired = target + reserve;
const selected = [...direct, ...gated.slice(0, Math.max(0, desired - direct.length))]
  .sort((left, right) => left.sourceRank - right.sourceRank);
if (selected.length < target) throw new Error(`Only ${selected.length} eligible sources are available for target ${target}.`);

const report = {
  generatedAt: new Date().toISOString(),
  target,
  reserve,
  selectedCount: selected.length,
  directCount: selected.filter((song) => !song.fingerprintRequired).length,
  fingerprintRequiredCount: selected.filter((song) => song.fingerprintRequired).length,
  eligibleFingerprintReserve: Math.max(0, gated.length - selected.filter((song) => song.fingerprintRequired).length),
  selected,
};
writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Selected ${selected.length}: direct=${report.directCount}, fingerprint-required=${report.fingerprintRequiredCount}, gated reserve=${report.eligibleFingerprintReserve}.`);
console.log(`Report: ${path.relative(root, outputFile)}`);
