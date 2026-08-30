export const difficulties = [
  "easy",
  "medium",
  "hard",
  "expert",
  "impossible",
] as const;

export type Difficulty = (typeof difficulties)[number];

export const eraFilters = ["all", "modern", "2010s", "2000s", "classics"] as const;
export type EraFilter = (typeof eraFilters)[number];

export const genreFilters = ["all", "pop", "hip-hop", "r&b", "rock", "dance", "other"] as const;
export type GenreFilter = (typeof genreFilters)[number];

export type FileAudioSource = {
  kind: "file";
  src: string;
};

export type SynthAudioSource = {
  kind: "synth";
  notes: number[];
  noteLengthMs?: number;
};

export type HostedAudioSource = {
  kind: "hosted";
  clueSrc: string;
  fullSrc: string;
  durationMs: number;
};

export type AudioSource = FileAudioSource | SynthAudioSource | HostedAudioSource;

export type Song = {
  id: string;
  title: string;
  artist: string;
  aliases?: string[];
  artistAliases?: string[];
  album?: string;
  spotifyUrl?: string;
  releaseYear?: number;
  genres?: string[];
  genreGroups?: Exclude<GenreFilter, "all">[];
  difficulty: Difficulty;
  familiarity?: number;
  recognitionScore?: number;
  streamReachScore?: number;
  genZRelevanceScore?: number;
  longevityScore?: number;
  introRecognition?: number;
  startAtMs?: number;
  clueGainDb?: number;
  playbackGainDb?: number;
  hookStartMs?: number;
  artwork?: string;
  audio: AudioSource;
};

export type RoundStatus = "playing" | "won" | "lost";
