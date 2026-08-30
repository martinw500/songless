import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AudioEngine } from "./lib/audio";
import {
  filterSongs,
  pickSongFromCycle,
  songMatchesQuery,
  stageOptions,
  stages,
  validateCatalog,
} from "./lib/game";
import {
  difficulties,
  eraFilters,
  genreFilters,
  type Difficulty,
  type EraFilter,
  type GenreFilter,
  type RoundStatus,
  type Song,
} from "./types";

const difficultyLabels: Record<Difficulty, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  expert: "Expert",
  impossible: "Impossible",
};
const AUTO_REROLL_SECONDS = 4;
const playHistoryStorageKey = "songless-play-history-v1";
type SelectableEra = Exclude<EraFilter, "all">;
type SelectableGenre = Exclude<GenreFilter, "all">;
const selectableEraFilters = eraFilters.filter((era): era is SelectableEra => era !== "all");
const selectableGenreFilters = genreFilters.filter((genre): genre is SelectableGenre => genre !== "all");

const eraLabels: Record<EraFilter, string> = {
  all: "All eras",
  modern: "Modern (2020+)",
  "2010s": "2010s",
  "2000s": "2000s",
  classics: "Classics (pre-2000)",
};

const genreLabels: Record<GenreFilter, string> = {
  all: "All genres",
  pop: "Pop",
  "hip-hop": "Hip-hop / Rap",
  "r&b": "R&B / Soul",
  rock: "Rock / Alternative",
  dance: "Dance / Electronic",
  other: "Other / Unclassified",
};

const stageStorageKey = "songless-stages-v2";

function initialStages(): number[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(stageStorageKey) ?? "null");
    if (!Array.isArray(saved)) return [...stages];
    const selected = stageOptions.filter((stage) => saved.includes(stage));
    return selected.length > 0 ? [...selected] : [...stages];
  } catch {
    return [...stages];
  }
}

function stageWeight(stage: number): number {
  return Math.max(0.58, Math.log10(stage * 100 + 1));
}

function stageCursorOffset(enabledStages: number[], stageIndex: number): number {
  const weights = enabledStages.map(stageWeight);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const completedWeight = weights
    .slice(0, Math.max(0, Math.min(stageIndex, weights.length)))
    .reduce((total, weight) => total + weight, 0);
  return totalWeight > 0 ? (completedWeight / totalWeight) * 100 : 0;
}

function stagePlaybackOffset(enabledStages: number[], stageIndex: number, elapsedSeconds: number): number {
  const weights = enabledStages.map(stageWeight);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight <= 0 || elapsedSeconds <= 0) return 0;

  let filledWeight = 0;
  let previousDuration = 0;
  const lastPlayableIndex = Math.max(0, Math.min(stageIndex, enabledStages.length - 1));
  for (let index = 0; index <= lastPlayableIndex; index += 1) {
    const duration = enabledStages[index];
    const interval = Math.max(0.0001, duration - previousDuration);
    const intervalProgress = Math.max(0, Math.min(1, (elapsedSeconds - previousDuration) / interval));
    filledWeight += weights[index] * intervalProgress;
    if (intervalProgress < 1) break;
    previousDuration = duration;
  }
  return (filledWeight / totalWeight) * 100;
}

const confettiPieces = Array.from({ length: 30 }, (_, index) => {
  const angle = (index / 30) * Math.PI * 2;
  const distance = 76 + (index % 6) * 15;
  const x = Math.round(Math.cos(angle) * distance);
  const y = Math.round(Math.sin(angle) * distance - 30);
  return {
    x,
    y,
    fall: y + 130 + (index % 5) * 18,
    rotation: 180 + (index % 7) * 70,
    delay: (index % 6) * 0.025,
    color: ["var(--accent)", "#e8fff2", "#77f6b2", "#ffffff", "#b7ffd6"][index % 5],
    round: index % 4 === 0,
  };
});

type PlayHistory = Record<string, string[]>;

function initialPlayHistory(): PlayHistory {
  try {
    const saved = JSON.parse(window.localStorage.getItem(playHistoryStorageKey) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string[]] => (
      Array.isArray(entry[1]) && entry[1].every((id) => typeof id === "string")
    )));
  } catch {
    return {};
  }
}

function initialFilterSelection<T extends string>(storageKey: string, allowed: readonly T[]): T[] {
  const saved = window.localStorage.getItem(storageKey);
  if (!saved) return [];
  try {
    const parsed: unknown = JSON.parse(saved);
    if (Array.isArray(parsed)) {
      return allowed.filter((option) => parsed.includes(option));
    }
  } catch {
    // Older builds stored one unquoted filter value. Keep it during migration.
  }
  return allowed.includes(saved as T) ? [saved as T] : [];
}

function initialEraFilter(): SelectableEra[] {
  return initialFilterSelection("songless-era-filter", selectableEraFilters);
}

function initialGenreFilter(): SelectableGenre[] {
  return initialFilterSelection("songless-genre-filter", selectableGenreFilters);
}

function toggleFilter<T extends string>(selection: T[], option: T, order: readonly T[]): T[] {
  const selected = new Set(selection);
  if (selected.has(option)) selected.delete(option);
  else selected.add(option);
  return order.filter((value) => selected.has(value));
}

function App() {
  const audioEngine = useRef(new AudioEngine());
  const playbackFrame = useRef<number | null>(null);
  const revealTimer = useRef<number | null>(null);
  const playbackRun = useRef(0);
  const playbackPending = useRef(false);
  const playHistory = useRef<PlayHistory>(initialPlayHistory());
  const [catalog, setCatalog] = useState<Song[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [eraFilter, setEraFilter] = useState<SelectableEra[]>(initialEraFilter);
  const [genreFilter, setGenreFilter] = useState<SelectableGenre[]>(initialGenreFilter);
  const [draftEraFilter, setDraftEraFilter] = useState<SelectableEra[]>(initialEraFilter);
  const [draftGenreFilter, setDraftGenreFilter] = useState<SelectableGenre[]>(initialGenreFilter);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [enabledStages, setEnabledStages] = useState<number[]>(initialStages);
  const [stageIndex, setStageIndex] = useState(0);
  const [status, setStatus] = useState<RoundStatus>("playing");
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const suggestionsListRef = useRef<HTMLDivElement>(null);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackStatus, setFeedbackStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [feedbackError, setFeedbackError] = useState("");
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [guessedSongIds, setGuessedSongIds] = useState<string[]>([]);
  const [audioError, setAudioError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlaybackPending, setIsPlaybackPending] = useState(false);
  const [isRevealPlaying, setIsRevealPlaying] = useState(false);
  const [playbackElapsed, setPlaybackElapsed] = useState(0);
  const [heardThrough, setHeardThrough] = useState(0);
  const [hasStartedRound, setHasStartedRound] = useState(false);
  const [volume, setVolume] = useState(() => {
    const storedVolume = window.localStorage.getItem("songless-volume-v2");
    if (storedVolume === null) return 1;
    const saved = Number(storedVolume);
    return Number.isFinite(saved) && saved >= 0 && saved <= 5 ? saved : 1;
  });
  const [autoReroll, setAutoReroll] = useState(() => (
    window.localStorage.getItem("songless-auto-reroll") === "true"
  ));
  const [autoRerollRemaining, setAutoRerollRemaining] = useState<number | null>(null);
  const [autoRerollCancelled, setAutoRerollCancelled] = useState(false);
  const [songStartMode, setSongStartMode] = useState<"intro" | "hook">(() => {
    const stored = window.localStorage.getItem("songless-start-mode");
    return stored === "hook" ? "hook" : "intro";
  });

  useEffect(() => {
    const controller = new AbortController();
    const reviewSongId = new URLSearchParams(window.location.search).get("reviewSong");
    const catalogSource = reviewSongId ? "/review-catalog.json" : "/catalog.json";
    fetch(catalogSource, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Catalogue request failed (${response.status}).`);
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        const songs = validateCatalog(value);
        setCatalog(reviewSongId ? songs.filter((song) => song.id === reviewSongId) : songs);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogError(error instanceof Error ? error.message : "Could not load the catalogue.");
      });

    return () => controller.abort();
  }, []);
  const catalogUsesHostedAudio = useMemo(
    () => catalog.some((song) => song.audio.kind === "hosted"),
    [catalog],
  );

  useEffect(() => {
    window.localStorage.setItem("songless-volume-v2", String(volume));
    audioEngine.current.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    window.localStorage.setItem("songless-auto-reroll", String(autoReroll));
  }, [autoReroll]);

  useEffect(() => {
    window.localStorage.setItem("songless-era-filter", JSON.stringify(eraFilter));
  }, [eraFilter]);

  useEffect(() => {
    window.localStorage.setItem("songless-genre-filter", JSON.stringify(genreFilter));
  }, [genreFilter]);

  useEffect(() => {
    if (!autoReroll || autoRerollCancelled || status === "playing" || !currentSong) {
      setAutoRerollRemaining(null);
      return undefined;
    }

    const deadline = Date.now() + AUTO_REROLL_SECONDS * 1000;
    const updateCountdown = () => {
      setAutoRerollRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 250);
    const timeout = window.setTimeout(() => advanceToNextSong(), AUTO_REROLL_SECONDS * 1000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [autoReroll, autoRerollCancelled, status, currentSong?.id]);

  useEffect(() => {
    window.localStorage.setItem("songless-start-mode", songStartMode);
  }, [songStartMode]);

  useEffect(() => {
    window.localStorage.setItem(stageStorageKey, JSON.stringify(enabledStages));
  }, [enabledStages]);

  useEffect(() => {
    const pool = filterSongs(catalog, difficulty, { era: eraFilter, genre: genreFilter });
    const song = drawSong(pool, currentSong?.id);
    setCurrentSong(song);
    resetRoundState();
  }, [catalog, difficulty, eraFilter, genreFilter]);

  useEffect(() => () => {
    playbackRun.current += 1;
    if (playbackFrame.current !== null) cancelAnimationFrame(playbackFrame.current);
    audioEngine.current.stop();
  }, []);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        difficulties.map((level) => [
          level,
          filterSongs(catalog, level, { era: eraFilter, genre: genreFilter }).length,
        ]),
      ) as Record<Difficulty, number>,
    [catalog, eraFilter, genreFilter],
  );

  const suggestions = useMemo(() => {
    if (!query.trim()) return [];
    return catalog
      .filter((song) => songMatchesQuery(song, query))
      .sort((a, b) => {
        const familiarity = (b.familiarity ?? 0) - (a.familiarity ?? 0);
        return familiarity || a.title.localeCompare(b.title);
      })
      .slice(0, 50);
  }, [catalog, query]);

  const selectedSong = selectedSongId
    ? catalog.find((song) => song.id === selectedSongId) ?? null
    : null;
  const activeFilterCount = eraFilter.length + genreFilter.length;
  const draftPoolCount = filterSongs(catalog, difficulty, {
    era: draftEraFilter,
    genre: draftGenreFilter,
  }).length;
  const currentStage = enabledStages[stageIndex] ?? enabledStages[0] ?? stages[0];
  const unlockedOffset = stageCursorOffset(enabledStages, stageIndex + 1);
  const playbackProgress = currentStage > 0 ? Math.min(1, playbackElapsed / currentStage) : 0;
  const playbackOffset = stagePlaybackOffset(enabledStages, stageIndex, playbackElapsed);

  // When in "hook" mode, override startAtMs with hookStartMs so audio begins at the chorus
  const playableSong = useMemo(() => {
    if (!currentSong) return null;
    if (songStartMode === "hook" && currentSong.hookStartMs != null) {
      return { ...currentSong, startAtMs: currentSong.hookStartMs };
    }
    return currentSong;
  }, [currentSong, songStartMode]);

  function stopPlayback(displayElapsed = 0) {
    playbackRun.current += 1;
    playbackPending.current = false;
    setIsPlaybackPending(false);
    if (playbackFrame.current !== null) {
      cancelAnimationFrame(playbackFrame.current);
      playbackFrame.current = null;
    }
    if (revealTimer.current !== null) {
      window.clearTimeout(revealTimer.current);
      revealTimer.current = null;
    }
    audioEngine.current.stop();
    setIsPlaying(false);
    setIsRevealPlaying(false);
    setPlaybackElapsed(displayElapsed);
  }

  async function startRevealPlayback(startSeconds: number) {
    if (!currentSong) return;
    const run = playbackRun.current;
    setAudioError("");
    try {
      // A reveal always restarts at the normal game intro. `playableSong` may
      // temporarily point at hookStartMs while hook mode is enabled, but that
      // clue-only offset must never leak into the win/loss playback.
      const actualDuration = await audioEngine.current.playRemainder(currentSong, startSeconds, volume);
      if (run !== playbackRun.current || actualDuration <= 0) return;
      setIsRevealPlaying(true);
      revealTimer.current = window.setTimeout(() => {
        if (run !== playbackRun.current) return;
        revealTimer.current = null;
        setIsRevealPlaying(false);
      }, actualDuration * 1000);
    } catch (error) {
      if (run !== playbackRun.current) return;
      setIsRevealPlaying(false);
      setAudioError(error instanceof Error ? error.message : "The reveal audio could not be played.");
    }
  }

  function finishRound(nextStatus: Exclude<RoundStatus, "playing">, reachedSeconds: number) {
    stopPlayback(reachedSeconds);
    setStatus(nextStatus);
    void startRevealPlayback(0);
  }

  function resetRoundState() {
    stopPlayback();
    setAutoRerollCancelled(false);
    setHeardThrough(0);
    setHasStartedRound(false);
    setStageIndex(0);
    setStatus("playing");
    setQuery("");
    setSelectedSongId(null);
    setGuessedSongIds([]);
    setAudioError("");
  }

  function activePoolKey(): string {
    return `${difficulty}|${eraFilter.join(",") || "all"}|${genreFilter.join(",") || "all"}`;
  }

  function drawSong(pool: Song[], avoidId?: string): Song | null {
    const key = activePoolKey();
    const result = pickSongFromCycle(pool, playHistory.current[key] ?? [], avoidId);
    const song = result.song;
    if (!song) return null;
    playHistory.current[key] = result.seenIds;
    window.localStorage.setItem(playHistoryStorageKey, JSON.stringify(playHistory.current));
    return song;
  }

  function advanceToNextSong() {
    const pool = filterSongs(catalog, difficulty, { era: eraFilter, genre: genreFilter });
    const song = drawSong(pool, currentSong?.id);
    setCurrentSong(song);
    resetRoundState();
  }

  function rerollAll() {
    advanceToNextSong();
  }

  function replayCurrentSong() {
    resetRoundState();
  }

  async function startPlayback(rangeStart: number, rangeEnd: number) {
    if (!playableSong || status !== "playing") return;
    const retainedThrough = Math.max(heardThrough, rangeStart);
    setHeardThrough(retainedThrough);
    stopPlayback(rangeStart);
    const run = playbackRun.current;
    playbackPending.current = true;
    setIsPlaybackPending(true);
    setAudioError("");
    try {
      const actualDuration = await audioEngine.current.play(
        playableSong,
        rangeStart,
        rangeEnd,
        volume,
      );
      if (run !== playbackRun.current || actualDuration <= 0) return;
      playbackPending.current = false;
      setIsPlaybackPending(false);
      setIsPlaying(true);
      const startedAt = performance.now();
      const durationMs = Math.max(1, actualDuration * 1000);
      const updateProgress = (now: number) => {
        if (run !== playbackRun.current) return;
        const progress = Math.min(1, (now - startedAt) / durationMs);
        setPlaybackElapsed(Math.min(rangeEnd, rangeStart + progress * actualDuration));
        if (progress < 1) {
          playbackFrame.current = requestAnimationFrame(updateProgress);
          return;
        }
        playbackFrame.current = null;
        setHeardThrough(rangeEnd);
        setIsPlaying(false);
      };
      playbackFrame.current = requestAnimationFrame(updateProgress);
    } catch (error) {
      if (run !== playbackRun.current) return;
      playbackPending.current = false;
      setIsPlaybackPending(false);
      setIsPlaying(false);
      setPlaybackElapsed(retainedThrough);
      setAudioError(error instanceof Error ? error.message : "The clip could not be played.");
    }
  }

  function playClip() {
    if (!currentSong || status !== "playing") return;
    if (isPlaying || playbackPending.current) {
      const pausedAt = Math.min(playbackElapsed, currentStage);
      setHeardThrough(pausedAt);
      stopPlayback(pausedAt);
      return;
    }
    const rangeStart = heardThrough >= currentStage ? 0 : heardThrough;
    setHasStartedRound(true);
    void startPlayback(rangeStart, currentStage);
  }

  function advanceOrLose() {
    setHeardThrough(currentStage);
    if (stageIndex < enabledStages.length - 1) {
      stopPlayback(currentStage);
      const nextIndex = stageIndex + 1;
      setStageIndex(nextIndex);
      return;
    }
    finishRound("lost", currentStage);
  }

  function submitGuess(guess?: Song) {
    if (!currentSong || status !== "playing") return;
    if (!guess) return;

    if (guess.id === currentSong.id) {
      finishRound("won", Math.max(heardThrough, playbackElapsed));
      return;
    }

    setGuessedSongIds((ids) => [...ids, guess.id]);
    setQuery("");
    setSelectedSongId(null);
    advanceOrLose();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (selectedSong) {
      submitGuess(selectedSong);
      return;
    }
    if (suggestions[0]) selectSuggestion(suggestions[0]);
  }

  function selectSuggestion(song: Song) {
    setSelectedSongId(song.id);
    setQuery(`${song.title} - ${song.artist}`);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((prev) => {
        const next = prev < suggestions.length - 1 ? prev + 1 : prev;
        scrollToSuggestion(next);
        return next;
      });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((prev) => {
        const next = prev > 0 ? prev - 1 : -1;
        scrollToSuggestion(next);
        return next;
      });
    } else if (event.key === "Enter" && highlightedIndex >= 0) {
      event.preventDefault();
      selectSuggestion(suggestions[highlightedIndex]);
    }
  }

  function scrollToSuggestion(index: number) {
    if (!suggestionsListRef.current || index < 0) return;
    const button = suggestionsListRef.current.children[index] as HTMLElement | undefined;
    if (button && button.scrollIntoView) {
      button.scrollIntoView({ block: "nearest" });
    }
  }

  function toggleStage(stage: number) {
    if (hasStartedRound) return;
    const isEnabled = enabledStages.includes(stage);
    if (isEnabled && enabledStages.length === 1) return;

    const nextStages: number[] = stageOptions.filter((option) =>
      option === stage ? !isEnabled : enabledStages.includes(option),
    );
    stopPlayback();
    setHeardThrough(0);
    setEnabledStages([...nextStages]);

    if (status !== "playing") {
      resetRoundState();
      return;
    }

    const nextCurrentStage = !isEnabled && stage < currentStage
      ? stage
      : nextStages.includes(currentStage)
        ? currentStage
        : nextStages.find((option) => option > currentStage) ?? nextStages[nextStages.length - 1];
    setStageIndex(Math.max(0, nextStages.indexOf(nextCurrentStage)));
    setAudioError("");
  }

  async function handleFeedbackSubmit(event: FormEvent) {
    event.preventDefault();
    if (!feedbackText.trim() || feedbackStatus === "submitting") return;

    setFeedbackStatus("submitting");
    setFeedbackError("");
    try {
      // The webhook lives on the server. Sending it from here would publish it
      // in the bundle, where anyone could read it and post to the channel.
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: feedbackText,
          song: currentSong ? `${currentSong.title} — ${currentSong.artist} (${currentSong.id})` : "",
        }),
      });

      const contentType = response.headers.get("content-type") ?? "";
      const reason = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : null;
      if (!response.ok || !reason?.ok) {
        throw new Error(reason?.error ?? `The feedback service returned ${response.status}.`);
      }

      setFeedbackStatus("success");
      setTimeout(() => {
        setIsFeedbackOpen(false);
        setFeedbackText("");
        setFeedbackStatus("idle");
      }, 2000);
    } catch (error) {
      console.error(error);
      setFeedbackError(error instanceof Error ? error.message : "");
      setFeedbackStatus("error");
    }
  }

  return (
    <main
      className="app-shell"
      data-difficulty={difficulty}
      data-song-id={currentSong?.id ?? ""}
      data-status={status}
    >
      <section className="game-layout">
        <aside className="mode-panel" aria-label="Difficulty">
          <nav className="difficulty-list">
            {difficulties.map((level) => (
              <button
                className={difficulty === level ? `difficulty ${level} active` : `difficulty ${level}`}
                disabled={catalog.length > 0 && counts[level] === 0}
                key={level}
                onClick={() => setDifficulty(level)}
                type="button"
              >
                {difficultyLabels[level]}
              </button>
            ))}
          </nav>
          <div className="mode-actions">
            <button className="mode-action" onClick={rerollAll} type="button">
              <RerollIcon /> Reroll all
            </button>
            {status === "lost" && (
              <button className="mode-action" onClick={replayCurrentSong} type="button">
                <ReplayIcon /> Play again
              </button>
            )}
            <button
              type="button"
              className={`mode-action filter-button${activeFilterCount ? " active-filter" : ""}`}
              onClick={() => {
                setDraftEraFilter(eraFilter);
                setDraftGenreFilter(genreFilter);
                setIsFiltersOpen(true);
              }}
            >
              <FilterIcon /> Filters{activeFilterCount ? ` (${activeFilterCount})` : ""}
            </button>
            <button
              type="button"
              className="mode-action feedback-button"
              onClick={() => setIsFeedbackOpen(true)}
              title="Send Feedback"
            >
              <FeedbackIcon />
              Feedback
            </button>

            <a
              href="https://buymeacoffee.com/songlessrecreation"
              target="_blank"
              rel="noopener noreferrer"
              className="mode-action support-button"
              title="Support this project on Buy Me A Coffee"
              style={{ textDecoration: 'none' }}
            >
              <CoffeeIcon />
              Support
            </a>
          </div>
        </aside>

        <section className="game-card" aria-live="polite">
          <div className={status === "playing" ? "game-content" : "game-content result-state"}>
            {status === "playing" && (
            <div className="difficulty-tabs" aria-label="Difficulty">
              {difficulties.map((level) => (
                <button
                  className={difficulty === level ? `${level} active` : level}
                  disabled={catalog.length > 0 && counts[level] === 0}
                  key={level}
                  onClick={() => setDifficulty(level)}
                  type="button"
                >
                  {difficultyLabels[level]}
                </button>
              ))}
            </div>
            )}

            {catalogError ? (
              <div className="empty-state">
                <span className="empty-icon">!</span>
                <h1>Catalogue error</h1>
                <p>{catalogError}</p>
              </div>
            ) : !currentSong ? (
              <div className="empty-state">
                <span className="empty-icon">{String.fromCharCode(9835)}</span>
                <h1>{catalog.length === 0 ? "Loading catalogue..." : "No songs match"}</h1>
                <p>{catalog.length === 0
                  ? "The song library is loading."
                  : "Try another difficulty or clear the era and genre filters."}</p>
              </div>
            ) : status !== "playing" ? (
              <div className={`result-panel ${status}`} key={`${status}-${currentSong.id}`}>
                <div className="result-artwork-wrap">
                  {status === "won" && (
                    <>
                      <span className="success-ring success-ring-one" aria-hidden="true" />
                      <span className="success-ring success-ring-two" aria-hidden="true" />
                      <Confetti />
                    </>
                  )}
                  <Artwork song={currentSong} />
                </div>
                {status === "lost" && <p className="result-kicker">It was...</p>}
                <h1>{currentSong.title}</h1>
                <p className="result-artist">
                  {currentSong.artist}
                  {currentSong.album && <span> &middot; {currentSong.album}</span>}
                </p>
                {currentSong.spotifyUrl && (
                  <a className="result-source-link" href={currentSong.spotifyUrl} target="_blank" rel="noreferrer">
                    Open in Spotify
                  </a>
                )}
                {isRevealPlaying && <span className="sr-only">Reveal audio is playing</span>}
                {audioError && <p className="audio-error" role="alert">{audioError}</p>}
                <div className="result-stamp">
                  {status === "won" ? `Guessed in ${currentStage}s!` : "Lost!"}
                </div>
                <div className="result-actions">
                  {status === "lost" && (
                    <button className="result-action result-retry-button" onClick={replayCurrentSong} type="button">
                      <ReplayIcon /> Retry
                    </button>
                  )}
                  <button className="result-action result-next-button primary" onClick={() => advanceToNextSong()} type="button">
                    Next song <NextIcon />
                  </button>
                </div>
                {autoReroll && autoRerollRemaining !== null && (
                  <div className="auto-reroll-countdown" role="status">
                    <span>Next song in {autoRerollRemaining}s</span>
                    <button
                      aria-label="Cancel auto reroll for this round"
                      onClick={() => setAutoRerollCancelled(true)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="round-panel">
                <div
                  className="stage-track"
                  data-stage-count={enabledStages.length}
                  aria-label={`Stage ${stageIndex + 1} of ${enabledStages.length}`}
                >
                  {stageOptions.map((stage) => {
                    const enabledIndex = enabledStages.indexOf(stage);
                    const isEnabled = enabledIndex >= 0;
                    const stateClass = !isEnabled
                      ? "disabled"
                      : enabledIndex < stageIndex
                        ? "passed"
                        : enabledIndex === stageIndex
                          ? "current"
                          : "upcoming";
                    const isLastEnabled = isEnabled && enabledIndex === enabledStages.length - 1;
                    return (
                      <span
                        aria-hidden={!isEnabled}
                        className={`stage-segment ${isEnabled ? "enabled" : "disabled"} ${stateClass}${isLastEnabled ? " last-enabled" : ""}`}
                        data-stage={stage}
                        key={stage}
                        style={{ flexGrow: isEnabled ? stageWeight(stage) : 0 }}
                        title={isEnabled ? `${stage} seconds` : undefined}
                      />
                    );
                  })}
                  <i
                    className="stage-unlocked-progress"
                    style={{ width: `${unlockedOffset}%` }}
                    aria-hidden="true"
                  />
                  <i
                    className="stage-playback-progress"
                    data-progress={playbackProgress.toFixed(3)}
                    data-elapsed={playbackElapsed.toFixed(3)}
                    style={{
                      width: `${playbackOffset}%`,
                    }}
                    aria-hidden="true"
                  />
                </div>

                <div className="player-area">
                  <button
                    className={`play-button${isPlaying ? " playing" : ""}${isPlaybackPending ? " loading" : ""}`}
                    onClick={playClip}
                    type="button"
                    aria-busy={isPlaybackPending}
                    aria-label={isPlaybackPending
                      ? "Cancel loading clip"
                      : isPlaying ? "Pause clip playback" : `Play ${currentStage} second clip`}
                  >
                    {isPlaybackPending ? <LoadingIcon /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
                    <span className="pulse-ring" />
                  </button>
                  <div className="stage-time">
                    <strong className="stage-value" key={currentStage}>{currentStage}</strong><span>s</span>
                  </div>
                </div>

                <form className="guess-form" onSubmit={handleSubmit}>
                  <div className={selectedSong ? "search-wrap selected" : "search-wrap"}>
                    <span className="search-icon" aria-hidden="true" />
                    <input
                      aria-label="Search songs"
                      autoComplete="off"
                      onKeyDown={handleKeyDown}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setSelectedSongId(null);
                        setHighlightedIndex(-1);
                      }}
                      placeholder="Search songs..."
                      value={query}
                    />
                    {query && !selectedSong && suggestions.length > 0 && (
                      <div className="suggestions" role="listbox" ref={suggestionsListRef}>
                        {suggestions.map((song, index) => (
                          <button
                            key={song.id}
                            className={index === highlightedIndex ? "highlighted" : ""}
                            onClick={() => selectSuggestion(song)}
                            onMouseMove={() => setHighlightedIndex(index)}
                            role="option"
                            aria-selected={index === highlightedIndex}
                            type="button"
                          >
                            <Artwork song={song} small />
                            <span><strong>{song.title}</strong><small>{song.artist}</small></span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {selectedSong ? (
                    <button className="guess-button" type="submit">Guess</button>
                  ) : (
                    <button className="skip-button" onClick={advanceOrLose} type="button">
                      <SkipIcon /> Skip
                    </button>
                  )}
                </form>
                {audioError && <p className="audio-error" role="alert">{audioError}</p>}

                {guessedSongIds.length > 0 && (
                  <div className="wrong-guesses">
                    {guessedSongIds.map((id, index) => {
                      const song = catalog.find((candidate) => candidate.id === id);
                      return song ? <span key={`${id}-${index}`}>x {song.title}</span> : null;
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="settings-panel">
          <div>
            <p className="eyebrow"><WaveformIcon /> Song start</p>
            <button
              className={`setting-value ${songStartMode === "intro" ? "active-setting" : ""}`}
              onClick={() => setSongStartMode("intro")}
              disabled={hasStartedRound}
              type="button"
            >
              From the start
            </button>
            <button
              className={`setting-value ${songStartMode === "hook" ? "active-setting" : ""}`}
              onClick={() => setSongStartMode("hook")}
              disabled={hasStartedRound}
              type="button"
            >
              Main hook
            </button>
          </div>
          <div>
            <p className="eyebrow"><StopwatchIcon /> Stages</p>
            <div className="stage-pills">
              {stageOptions.map((stage) => {
                const isEnabled = enabledStages.includes(stage);
                const isCurrent = isEnabled && currentStage === stage && status === "playing";
                return (
                <button
                  aria-label={`${isEnabled ? "Remove" : "Add"} ${stage} second stage`}
                  aria-pressed={isEnabled}
                  className={`stage-pill${isEnabled ? " enabled" : ""}${isCurrent ? " current" : ""}`}
                  disabled={hasStartedRound}
                  key={stage}
                  onClick={() => toggleStage(stage)}
                  title={hasStartedRound
                    ? "Stage settings are locked for this round"
                    : `${isEnabled ? "Remove" : "Add"} ${stage}s stage`}
                  type="button"
                >
                  {stage}s
                </button>
                );
              })}
            </div>
          </div>
          <div>
            <p className="eyebrow"><AutoRerollIcon /> Next song</p>
            <button
              aria-pressed={autoReroll}
              className={`setting-value${autoReroll ? " active-setting" : ""}`}
              onClick={() => setAutoReroll((enabled) => !enabled)}
              type="button"
            >
              Auto reroll {autoReroll ? `on · ${AUTO_REROLL_SECONDS}s` : "off"}
            </button>
          </div>
          <label className="volume-control">
            <div className="volume-header">
              <span className="eyebrow"><VolumeIcon /> Volume</span>
              <span className="volume-value">{Math.round(volume * 100)}%</span>
            </div>
            <div className="volume-slider-row">
              <input
                aria-label="Volume"
                min="0"
                max="5"
                step="0.01"
                type="range"
                value={volume}
                style={{ "--volume-percent": `${Math.min(100, volume * 20)}%` } as CSSProperties}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              {volume !== 1 && (
                <button
                  type="button"
                  className="volume-reset"
                  onClick={() => setVolume(1)}
                  aria-label="Reset volume to 100%"
                  title="Reset to 100%"
                >
                  <ResetIcon />
                </button>
              )}
            </div>
          </label>
        </aside>
      </section>

      {isFiltersOpen && (
        <div className="modal-overlay" onClick={() => setIsFiltersOpen(false)}>
          <div className="modal-content filter-modal" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setIsFiltersOpen(false)} aria-label="Close filters">
              &times;
            </button>
            <div className="filter-heading">
              <FilterIcon />
              <div>
                <h2>Song filters</h2>
                <p>{draftPoolCount} {draftPoolCount === 1 ? "song" : "songs"} available in {difficultyLabels[difficulty]}</p>
              </div>
            </div>
            <fieldset className="filter-group">
              <legend>Era <span>(select any)</span></legend>
              <div className="filter-options">
                {eraFilters.map((era) => {
                  const selected = era === "all" ? draftEraFilter.length === 0 : draftEraFilter.includes(era);
                  return (
                    <button
                      aria-pressed={selected}
                      className={selected ? "selected" : ""}
                      key={era}
                      onClick={() => setDraftEraFilter(era === "all"
                        ? []
                        : toggleFilter(draftEraFilter, era, selectableEraFilters))}
                      type="button"
                    >
                      {eraLabels[era]}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="filter-group">
              <legend>Genre <span>(select any)</span></legend>
              <div className="filter-options">
                {genreFilters.map((genre) => {
                  const selected = genre === "all"
                    ? draftGenreFilter.length === 0
                    : draftGenreFilter.includes(genre);
                  return (
                    <button
                      aria-pressed={selected}
                      className={selected ? "selected" : ""}
                      key={genre}
                      onClick={() => setDraftGenreFilter(genre === "all"
                        ? []
                        : toggleFilter(draftGenreFilter, genre, selectableGenreFilters))}
                      type="button"
                    >
                      {genreLabels[genre]}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="filter-footer">
              <button
                className="filter-clear"
                disabled={draftEraFilter.length === 0 && draftGenreFilter.length === 0}
                onClick={() => {
                  setDraftEraFilter([]);
                  setDraftGenreFilter([]);
                }}
                type="button"
              >
                Clear filters
              </button>
              <button
                className="filter-done"
                disabled={draftPoolCount === 0}
                onClick={() => {
                  setEraFilter(draftEraFilter);
                  setGenreFilter(draftGenreFilter);
                  setIsFiltersOpen(false);
                }}
                type="button"
              >
                Play this mix
              </button>
            </div>
          </div>
        </div>
      )}

      {isFeedbackOpen && (
        <div className="modal-overlay" onClick={() => setIsFeedbackOpen(false)}>
          <div className="modal-content feedback-modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setIsFeedbackOpen(false)} aria-label="Close">
              &times;
            </button>
            <h2>Send Feedback</h2>
            <p className="modal-desc">Tell us what you think, report a bug, or request a new feature!</p>
            
            <form onSubmit={handleFeedbackSubmit}>
              <textarea 
                className="feedback-textarea"
                placeholder="What's on your mind?"
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
                disabled={feedbackStatus === "submitting" || feedbackStatus === "success"}
                autoFocus
                required
              />
              
              {feedbackStatus === "error" && (
                <p className="modal-error">{feedbackError || "Feedback could not be sent. Please try again."}</p>
              )}
              
              <button 
                type="submit" 
                className={`modal-submit ${feedbackStatus}`}
                disabled={feedbackStatus === "submitting" || feedbackStatus === "success" || !feedbackText.trim()}
              >
                {feedbackStatus === "submitting" ? "Sending..." : feedbackStatus === "success" ? "Sent!" : "Submit"}
              </button>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

function Artwork({ song, small = false }: { song: Song; small?: boolean }) {
  const [failedArtwork, setFailedArtwork] = useState<string | null>(null);
  if (song.artwork && failedArtwork !== song.artwork) {
    return (
      <img
        className={small ? "artwork small" : "artwork"}
        data-artwork-id={song.id}
        decoding="async"
        key={`${song.id}:${song.artwork}`}
        loading={small ? "lazy" : "eager"}
        onError={() => setFailedArtwork(song.artwork ?? null)}
        src={song.artwork}
        alt=""
      />
    );
  }
  return (
    <span
      className={small ? "artwork fallback small" : "artwork fallback"}
      data-artwork-id={song.id}
      aria-hidden="true"
    >
      {String.fromCharCode(9835)}
    </span>
  );
}

function Confetti() {
  return (
    <span className="confetti" aria-hidden="true">
      {confettiPieces.map((piece, index) => (
        <span
          className={piece.round ? "confetti-piece round" : "confetti-piece"}
          key={index}
          style={{
            "--confetti-x": `${piece.x}px`,
            "--confetti-y": `${piece.y}px`,
            "--confetti-fall": `${piece.fall}px`,
            "--confetti-rotation": `${piece.rotation}deg`,
            "--confetti-delay": `${piece.delay}s`,
            "--confetti-color": piece.color,
          } as CSSProperties}
        />
      ))}
    </span>
  );
}

function VolumeIcon() {
  return (
    <svg className="label-icon volume-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.25 6.1v3.8h2.2l3.1 2.65V3.45L4.45 6.1h-2.2Z" />
      <path d="M9.7 5.25c.75.72 1.12 1.64 1.12 2.75s-.37 2.03-1.12 2.75M11.65 3.55c1.2 1.18 1.8 2.66 1.8 4.45s-.6 3.27-1.8 4.45" />
    </svg>
  );
}

function WaveformIcon() {
  return (
    <svg className="label-icon waveform-icon" viewBox="0 0 18 14" aria-hidden="true">
      <path d="M1 7h1.5M4 4.5v5M6.5 2v10M9 4v6M11.5 1v12M14 4.5v5M16 7h1" />
    </svg>
  );
}

function StopwatchIcon() {
  return (
    <svg className="label-icon stopwatch-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 1.5h4M8 3.25v1M12.15 4.35l1.05-1.05M8 14.25a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" />
      <path d="M8 7v2.2l1.45.9" />
    </svg>
  );
}

function AutoRerollIcon() {
  return (
    <svg className="label-icon auto-reroll-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.1 5.4A5.4 5.4 0 0 1 12.7 4" />
      <path d="M12.7 1.8V4H10.5" />
      <path d="M12.9 10.6A5.4 5.4 0 0 1 3.3 12" />
      <path d="M3.3 14.2V12h2.2" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="play-glyph play-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.3 6.55c0-1.72 1.88-2.78 3.35-1.9l7.35 4.4c1.43.86 1.43 2.94 0 3.8l-7.35 4.4c-1.47.88-3.35-.18-3.35-1.9v-8.8Z" />
    </svg>
  );
}

function LoadingIcon() {
  return (
    <svg className="play-glyph loading-icon" viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" strokeWidth="5" opacity="0.28" />
      <path d="M24 7a17 17 0 0 1 17 17" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="play-glyph pause-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4.5" height="14" rx="1.4" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1.4" />
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg className="skip-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path className="skip-icon-triangle" d="M3.75 5.45c0-1.02 1.12-1.64 1.98-1.1l7.02 4.42c.8.5.8 1.66 0 2.16l-7.02 4.42c-.86.54-1.98-.08-1.98-1.1v-8.8Z" />
      <path className="skip-icon-bar" d="M15.65 4.8v10.4" />
    </svg>
  );
}

function RerollIcon() {
  return (
    <svg className="action-icon dice-icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.75" y="7.25" width="9.5" height="9.5" rx="1.6" />
      <path d="M6.25 7.25V4.9c0-.92.73-1.65 1.65-1.65h7.2c.92 0 1.65.73 1.65 1.65v7.2c0 .92-.73 1.65-1.65 1.65h-2.85" />
      <circle cx="5.75" cy="10.25" r=".7" className="pip" />
      <circle cx="9.25" cy="13.75" r=".7" className="pip" />
      <circle cx="9.75" cy="6.75" r=".7" className="pip" />
      <circle cx="13.25" cy="10.25" r=".7" className="pip" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg className="action-icon filter-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 3.25h12M4.2 8h7.6M6.4 12.75h3.2" />
      <circle cx="5.2" cy="3.25" r="1.15" />
      <circle cx="10.7" cy="8" r="1.15" />
      <circle cx="7.4" cy="12.75" r="1.15" />
    </svg>
  );
}

function ReplayIcon() {
  return (
    <svg className="action-icon replay-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.2 9.2A8.5 8.5 0 1 1 3.8 15" />
      <path d="M4.2 4.5v4.7h4.7" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg className="action-icon next-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 10h12" />
      <path d="m11.5 6 4 4-4 4" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg className="reset-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 5.5A5.5 5.5 0 1 1 2.2 9.5" />
      <path d="M2.5 2v3.5h3.5" />
    </svg>
  );
}

function FeedbackIcon() {
  return (
    <svg className="action-icon feedback-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

function CoffeeIcon() {
  return (
    <svg className="action-icon coffee-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
      <line x1="6" x2="6" y1="2" y2="4" />
      <line x1="10" x2="10" y1="2" y2="4" />
      <line x1="14" x2="14" y1="2" y2="4" />
    </svg>
  );
}

export default App;
