import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const metadataDirectory = path.join(root, "data", "itunes-track-metadata.local");

if (!existsSync(metadataDirectory)) {
  throw new Error(`Cached track metadata is missing: ${metadataDirectory}`);
}

const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const yearById = new Map();
for (const filename of readdirSync(metadataDirectory)) {
  if (!filename.endsWith(".json")) continue;
  const metadata = JSON.parse(readFileSync(path.join(metadataDirectory, filename), "utf8"));
  if (Number.isInteger(metadata?.releaseYear)) {
    yearById.set(filename.replace(/\.json$/u, ""), metadata.releaseYear);
  }
}

let updated = 0;
for (const song of candidateRoot.songs) {
  if (Number.isInteger(song.releaseYear)) continue;
  const releaseYear = yearById.get(song.id);
  if (!releaseYear) continue;
  song.releaseYear = releaseYear;
  updated += 1;
}

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`Applied ${updated} cached release years.`);
