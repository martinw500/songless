import type { Difficulty, Song } from "../types";

export const stages = [0.1, 0.5, 2, 8, 15] as const;
export const stageOptions = [0.01, ...stages] as const;

export function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\b(feat|featuring|ft)\.?\b.*$/g, "")
    .replace(/\b(remaster(?:ed)?|radio edit|single version)\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .normalize("NFC")
    .trim();
}

export function songMatchesQuery(song: Song, rawQuery: string): boolean {
  const query = normalizeAnswer(rawQuery);
  if (!query) return false;

  const searchable = [
    song.title,
    song.artist,
    `${song.title} ${song.artist}`,
    ...(song.aliases ?? []),
    ...(song.artistAliases ?? []),
  ].map(normalizeAnswer);

  return searchable.some((value) => value.includes(query));
}

export function filterSongs(
  songs: Song[],
  difficulty: Difficulty,
): Song[] {
  return songs.filter((song) => song.difficulty === difficulty);
}

export function pickSong(songs: Song[], excludedIds: Set<string>): Song | null {
  if (songs.length === 0) return null;

  const unseen = songs.filter((song) => !excludedIds.has(song.id));
  const candidates = unseen.length > 0 ? unseen : songs;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

export function validateCatalog(value: unknown): Song[] {
  if (!Array.isArray(value)) {
    throw new Error("The catalogue must be a JSON array.");
  }

  return value.filter((item): item is Song => {
    if (!item || typeof item !== "object") return false;
    const song = item as Partial<Song>;
    if (!song.audio || typeof song.audio !== "object" || !("kind" in song.audio)) return false;
    const audio = song.audio;
    const validAudio = audio.kind === "synth"
      ? Array.isArray(audio.notes) && audio.notes.length > 0 && audio.notes.every(Number.isFinite)
      : audio.kind === "file"
        ? typeof audio.src === "string" && audio.src.length > 0
        : audio.kind === "hosted"
            ? /^https:\/\//u.test(audio.clueSrc)
              && /^https:\/\//u.test(audio.fullSrc)
              && Number.isFinite(audio.durationMs)
              && audio.durationMs >= 15_000
          : false;
    const validStart = song.startAtMs === undefined
      || (Number.isInteger(song.startAtMs) && song.startAtMs >= 0);
    return Boolean(
      song.id &&
        song.title &&
        song.artist &&
        song.difficulty &&
        validAudio &&
        validStart,
    );
  });
}
