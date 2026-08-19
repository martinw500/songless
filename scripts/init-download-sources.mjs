import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "data", "song-download-sources.local.json");
if (existsSync(target) && !process.argv.includes("--force")) {
  throw new Error("data/song-download-sources.local.json already exists. Edit it or rerun with --force to replace it.");
}
const candidates = JSON.parse(readFileSync(path.join(root, "data", "song-candidates.json"), "utf8"));
const manifest = {
  songs: candidates.songs.map((song) => ({ id: song.id, title: song.title, artist: song.artist, url: "" })),
};
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Created an ignored ${manifest.songs.length}-song source manifest at ${target}.`);
