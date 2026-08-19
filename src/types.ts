export const difficulties = [
  "easy",
  "medium",
  "hard",
  "expert",
  "impossible",
] as const;

export type Difficulty = (typeof difficulties)[number];

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
  difficulty: Difficulty;
  familiarity?: number;
  introRecognition?: number;
  startAtMs?: number;
  artwork?: string;
  audio: AudioSource;
};

export type RoundStatus = "playing" | "won" | "lost";
