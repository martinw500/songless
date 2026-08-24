import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateFile = path.join(root, "data", "song-candidates.json");
const overrideFile = path.join(root, "data", "artist-credit-overrides.json");
const candidateRoot = JSON.parse(readFileSync(candidateFile, "utf8"));
const overrides = JSON.parse(readFileSync(overrideFile, "utf8")).songs;
const candidates = new Map(candidateRoot.songs.map((song) => [song.id, song]));
const seen = new Set();

for (const override of overrides) {
  if (seen.has(override.id)) throw new Error(`Duplicate artist-credit override: ${override.id}`);
  seen.add(override.id);
  const song = candidates.get(override.id);
  if (!song) throw new Error(`Unknown artist-credit override id: ${override.id}`);
  if (!override.artist?.trim() || !Array.isArray(override.primaryArtists) || override.primaryArtists.length === 0
    || override.primaryArtists.some((artist) => !artist?.trim()) || !override.reason?.trim()) {
    throw new Error(`Invalid artist-credit override: ${override.id}`);
  }
  song.artist = override.artist;
  song.primaryArtists = override.primaryArtists;
  console.log(`${override.id}: ${override.artist}`);
}

writeFileSync(candidateFile, `${JSON.stringify(candidateRoot, null, 2)}\n`, "utf8");
console.log(`Applied ${overrides.length} reviewed artist-credit overrides.`);
