import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidateRoot = JSON.parse(readFileSync(path.join(root, "data", "song-candidates.json"), "utf8"));
const songs = candidateRoot.songs
  .filter((song) => song.media?.hostedClueUrl && song.media?.hostedFullUrl && Number.isInteger(song.media.hostedDurationMs))
  .map((song) => ({
    id: song.id,
    title: song.title,
    artist: song.artist,
    aliases: song.aliases,
    artistAliases: song.artistAliases,
    ...(song.album ? { album: song.album } : {}),
    ...(song.spotifyUrl ? { spotifyUrl: song.spotifyUrl } : {}),
    releaseYear: song.releaseYear,
    genres: song.genres,
    difficulty: "easy",
    familiarity: song.familiarity,
    introRecognition: song.introRecognition ?? undefined,
    startAtMs: song.startAtMs ?? 0,
    ...(song.clueGainDb != null ? { clueGainDb: song.clueGainDb } : {}),
    artwork: song.media.artworkUrl,
    audio: {
      kind: "hosted",
      clueSrc: song.media.hostedClueUrl,
      fullSrc: song.media.hostedFullUrl,
      durationMs: song.media.hostedDurationMs,
    },
  }));

writeFileSync(path.join(root, "public", "review-catalog.json"), `${JSON.stringify(songs, null, 2)}\n`, "utf8");
console.log(`Built a ${songs.length}-song hosted review catalogue. Open /?reviewSong=<candidate-id> while the dev server is running.`);
