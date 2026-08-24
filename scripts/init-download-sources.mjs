import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sortCandidatesBillionFirst } from "./song-priority.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "data", "song-download-sources.local.json");
const candidates = JSON.parse(readFileSync(path.join(root, "data", "song-candidates.json"), "utf8"));
const longlist = JSON.parse(readFileSync(path.join(root, "data", "song-longlist.json"), "utf8"));
const reset = process.argv.includes("--force");
const existingSongs = existsSync(target) && !reset
  ? JSON.parse(readFileSync(target, "utf8")).songs ?? []
  : [];
const existingById = new Map(existingSongs.map((song) => [song.id, song]));
const manifest = {
  songs: sortCandidatesBillionFirst(candidates.songs, longlist).map((song) => ({
    ...(existingById.get(song.id) ?? {}),
    id: song.id,
    title: song.title,
    artist: song.artist,
    url: existingById.get(song.id)?.url ?? "",
  })),
};
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const preserved = manifest.songs.filter((song) => song.url).length;
console.log(`Synced ${manifest.songs.length} candidate rows in billion-stream/source-rank priority; preserved ${preserved} resolved URL(s).`);
