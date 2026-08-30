import type { Difficulty, EraFilter, GenreFilter, Song } from "../types";

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
  filters?: {
    era?: EraFilter | readonly EraFilter[];
    genre?: GenreFilter | readonly GenreFilter[];
  },
): Song[] {
  return songs.filter((song) => song.difficulty === difficulty
    && songMatchesAnyEra(song, filters?.era ?? "all")
    && songMatchesAnyGenre(song, filters?.genre ?? "all"));
}

function songMatchesAnyEra(song: Song, selection: EraFilter | readonly EraFilter[]): boolean {
  const eras = Array.isArray(selection) ? selection : [selection];
  return eras.length === 0 || eras.includes("all") || eras.some((era) => songMatchesEra(song, era));
}

export function songMatchesEra(song: Song, era: EraFilter): boolean {
  if (era === "all") return true;
  if (!Number.isInteger(song.releaseYear)) return false;
  if (era === "modern") return song.releaseYear! >= 2020;
  if (era === "2010s") return song.releaseYear! >= 2010 && song.releaseYear! <= 2019;
  if (era === "2000s") return song.releaseYear! >= 2000 && song.releaseYear! <= 2009;
  return song.releaseYear! < 2000;
}

export function genreGroups(song: Song): Set<Exclude<GenreFilter, "all">> {
  if (song.genreGroups?.length) return new Set(song.genreGroups);
  const values = (song.genres ?? []).map((genre) => genre.toLowerCase());
  const groups = new Set<Exclude<GenreFilter, "all">>();
  for (const genre of values) {
    if (/pop|adult contemporary|soundtrack/u.test(genre)) groups.add("pop");
    if (/hip.?hop|rap|trap/u.test(genre)) groups.add("hip-hop");
    if (/r&b|rhythm and blues|soul/u.test(genre)) groups.add("r&b");
    if (/rock|grunge|metal|britpop|new wave|alternative|indie/u.test(genre)) groups.add("rock");
    if (/dance|electro|house|disco|reggaeton|latin|afrobeat|funk/u.test(genre)) groups.add("dance");
  }
  if (groups.size === 0) groups.add("other");
  return groups;
}

export function songMatchesGenre(song: Song, genre: GenreFilter): boolean {
  return genre === "all" || genreGroups(song).has(genre);
}

function songMatchesAnyGenre(song: Song, selection: GenreFilter | readonly GenreFilter[]): boolean {
  const genres = Array.isArray(selection) ? selection : [selection];
  return genres.length === 0 || genres.includes("all")
    || genres.some((genre) => songMatchesGenre(song, genre));
}

export function pickSong(songs: Song[], excludedIds: Set<string>): Song | null {
  if (songs.length === 0) return null;

  const unseen = songs.filter((song) => !excludedIds.has(song.id));
  const candidates = unseen.length > 0 ? unseen : songs;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

export function pickSongFromCycle(
  songs: Song[],
  seenIds: Iterable<string>,
  avoidId?: string,
): { song: Song | null; seenIds: string[] } {
  if (songs.length === 0) return { song: null, seenIds: [] };
  const eligibleIds = new Set(songs.map((song) => song.id));
  const seen = new Set([...seenIds].filter((id) => eligibleIds.has(id)));
  if (songs.every((song) => seen.has(song.id))) {
    seen.clear();
    if (avoidId && songs.length > 1 && eligibleIds.has(avoidId)) seen.add(avoidId);
  }
  const song = pickSong(songs, seen);
  if (song) seen.add(song.id);
  return { song, seenIds: [...seen] };
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
    const validClueGain = song.clueGainDb === undefined
      || (Number.isFinite(song.clueGainDb) && song.clueGainDb >= 0 && song.clueGainDb <= 12);
    const validPlaybackGain = song.playbackGainDb === undefined
      || (Number.isFinite(song.playbackGainDb) && song.playbackGainDb >= 0 && song.playbackGainDb <= 12);
    return Boolean(
      song.id &&
        song.title &&
        song.artist &&
        song.difficulty &&
        validAudio &&
        validStart &&
        validClueGain &&
        validPlaybackGain,
    );
  });
}
