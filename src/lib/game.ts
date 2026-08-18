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
    .replace(/[^a-z0-9]+/g, " ")
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
    return Boolean(
      song.id &&
        song.title &&
        song.artist &&
        song.difficulty &&
        song.audio &&
        typeof song.audio === "object" &&
        "kind" in song.audio,
    );
  });
}
