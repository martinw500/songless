import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "data", "song-download-sources.local.json");
const candidates = JSON.parse(readFileSync(path.join(root, "data", "song-candidates.json"), "utf8"));
const reset = process.argv.includes("--force");
const existingSongs = existsSync(target) && !reset
  ? JSON.parse(readFileSync(target, "utf8")).songs ?? []
  : [];
const existingById = new Map(existingSongs.map((song) => [song.id, song]));
const manifest = {
  songs: candidates.songs.map((song) => ({
    ...(existingById.get(song.id) ?? {}),
    id: song.id,
    title: song.title,
    artist: song.artist,
    url: existingById.get(song.id)?.url ?? "",
  })),
};
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const preserved = manifest.songs.filter((song) => song.url).length;
console.log(`Synced ${manifest.songs.length} candidate rows in the ignored source manifest; preserved ${preserved} resolved URL(s).`);
