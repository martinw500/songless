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
  pickSong,
  songMatchesQuery,
  stageOptions,
  stages,
  validateCatalog,
} from "./lib/game";
import {
  difficulties,
  type Difficulty,
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

const initialSeen = (): Record<Difficulty, Set<string>> => ({
  easy: new Set(),
  medium: new Set(),
  hard: new Set(),
  expert: new Set(),
  impossible: new Set(),
});

function App() {
  const audioEngine = useRef(new AudioEngine());
  const playbackFrame = useRef<number | null>(null);
  const playbackRun = useRef(0);
  const playbackPending = useRef(false);
  const seenSongs = useRef(initialSeen());
  const [catalog, setCatalog] = useState<Song[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [enabledStages, setEnabledStages] = useState<number[]>(initialStages);
  const [stageIndex, setStageIndex] = useState(0);
  const [status, setStatus] = useState<RoundStatus>("playing");
  const [query, setQuery] = useState("");
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [guessedSongIds, setGuessedSongIds] = useState<string[]>([]);
  const [audioError, setAudioError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackElapsed, setPlaybackElapsed] = useState(0);
  const [heardThrough, setHeardThrough] = useState(0);
  const [hasStartedRound, setHasStartedRound] = useState(false);
  const [volume, setVolume] = useState(() => {
    const storedVolume = window.localStorage.getItem("songless-volume-v2");
    if (storedVolume === null) return 1;
    const saved = Number(storedVolume);
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 0.8;
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/catalog.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Catalogue request failed (${response.status}).`);
        return response.json() as Promise<unknown>;
      })
      .then((value) => setCatalog(validateCatalog(value)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCatalogError(error instanceof Error ? error.message : "Could not load the catalogue.");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    window.localStorage.setItem("songless-volume-v2", String(volume));
  }, [volume]);

  useEffect(() => {
    window.localStorage.setItem(stageStorageKey, JSON.stringify(enabledStages));
  }, [enabledStages]);

  useEffect(() => {
    const pool = filterSongs(catalog, difficulty);
    const song = pickSong(pool, seenSongs.current[difficulty]);
    if (song) seenSongs.current[difficulty].add(song.id);
    setCurrentSong(song);
    resetRoundState();
  }, [catalog, difficulty]);

  useEffect(() => () => {
    playbackRun.current += 1;
    if (playbackFrame.current !== null) cancelAnimationFrame(playbackFrame.current);
    audioEngine.current.stop();
  }, []);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        difficulties.map((level) => [level, filterSongs(catalog, level).length]),
      ) as Record<Difficulty, number>,
    [catalog],
  );

  const suggestions = useMemo(() => {
    if (!query.trim()) return [];
    return catalog
      .filter((song) => songMatchesQuery(song, query))
      .sort((a, b) => {
        const familiarity = (b.familiarity ?? 0) - (a.familiarity ?? 0);
        return familiarity || a.title.localeCompare(b.title);
      })
      .slice(0, 7);
  }, [catalog, query]);

  const selectedSong = selectedSongId
    ? catalog.find((song) => song.id === selectedSongId) ?? null
    : null;
  const currentStage = enabledStages[stageIndex] ?? enabledStages[0] ?? stages[0];
  const unlockedOffset = stageCursorOffset(enabledStages, stageIndex + 1);
  const playbackProgress = currentStage > 0 ? Math.min(1, playbackElapsed / currentStage) : 0;
  const playbackOffset = stagePlaybackOffset(enabledStages, stageIndex, playbackElapsed);

  function stopPlayback(displayElapsed = 0) {
    playbackRun.current += 1;
    playbackPending.current = false;
    if (playbackFrame.current !== null) {
      cancelAnimationFrame(playbackFrame.current);
      playbackFrame.current = null;
    }
    audioEngine.current.stop();
    setIsPlaying(false);
    setPlaybackElapsed(displayElapsed);
  }

  function resetRoundState() {
    stopPlayback();
    setHeardThrough(0);
    setHasStartedRound(false);
    setStageIndex(0);
    setStatus("playing");
    setQuery("");
    setSelectedSongId(null);
    setGuessedSongIds([]);
    setAudioError("");
  }

  function rerollAll() {
    seenSongs.current = initialSeen();
    if (currentSong) seenSongs.current[difficulty].add(currentSong.id);
    const pool = filterSongs(catalog, difficulty);
    const song = pickSong(pool, seenSongs.current[difficulty]);
    if (song) seenSongs.current[difficulty].add(song.id);
    setCurrentSong(song);
    resetRoundState();
  }

  function replayCurrentSong() {
    resetRoundState();
  }

  async function startPlayback(rangeStart: number, rangeEnd: number) {
    if (!currentSong || status !== "playing") return;
    const retainedThrough = Math.max(heardThrough, rangeStart);
    setHeardThrough(retainedThrough);
    stopPlayback(rangeStart);
    const run = playbackRun.current;
    playbackPending.current = true;
    setAudioError("");
    try {
      const actualDuration = await audioEngine.current.play(
        currentSong,
        rangeStart,
        rangeEnd,
        volume,
      );
      if (run !== playbackRun.current || actualDuration <= 0) return;
      playbackPending.current = false;
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
      setIsPlaying(false);
      setPlaybackElapsed(retainedThrough);
      setAudioError(error instanceof Error ? error.message : "The clip could not be played.");
    }
  }

  function playClip() {
    if (!currentSong || status !== "playing") return;
    if (isPlaying || playbackPending.current) {
      stopPlayback(Math.min(heardThrough, currentStage));
      return;
    }
    const previousStage = stageIndex > 0 ? enabledStages[stageIndex - 1] : 0;
    const rangeStart = heardThrough >= currentStage ? 0 : previousStage;
    setHasStartedRound(true);
    void startPlayback(rangeStart, currentStage);
  }

  function advanceOrLose() {
    stopPlayback(Math.min(heardThrough, currentStage));
    if (stageIndex < enabledStages.length - 1) {
      const nextIndex = stageIndex + 1;
      setStageIndex(nextIndex);
      return;
    }
    setStatus("lost");
  }

  function submitGuess(guess?: Song) {
    if (!currentSong || status !== "playing") return;
    if (!guess) return;

    if (guess.id === currentSong.id) {
      stopPlayback();
      setStatus("won");
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

  return (
    <main className="app-shell" data-difficulty={difficulty} data-status={status}>
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
                <h1>{catalog.length === 0 ? "Loading catalogue..." : "No songs in this mode"}</h1>
                <p>Add a song with the "{difficulty}" difficulty to public/catalog.json.</p>
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
                <div className="result-stamp">
                  {status === "won" ? `Guessed in ${currentStage}s!` : "Lost!"}
                </div>
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
                    className={isPlaying ? "play-button playing" : "play-button"}
                    onClick={playClip}
                    type="button"
                    aria-label={isPlaying ? "Stop clip playback" : `Play ${currentStage} second clip`}
                  >
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
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
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setSelectedSongId(null);
                      }}
                      placeholder="Search songs..."
                      value={query}
                    />
                    {query && !selectedSong && suggestions.length > 0 && (
                      <div className="suggestions" role="listbox">
                        {suggestions.map((song) => (
                          <button
                            key={song.id}
                            onClick={() => selectSuggestion(song)}
                            role="option"
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
            <button className="setting-value" disabled type="button">Spotify preview</button>
            <button className="setting-value active-setting" type="button">From the start</button>
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
          <label className="volume-control">
            <span className="eyebrow"><VolumeIcon /> Volume</span>
            <div>
              <input
                aria-label="Volume"
                min="0"
                max="1"
                step="0.01"
                type="range"
                value={volume}
                style={{ "--volume-percent": `${volume * 100}%` } as CSSProperties}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </div>
          </label>
        </aside>
      </section>
    </main>
  );
}

function Artwork({ song, small = false }: { song: Song; small?: boolean }) {
  if (song.artwork) {
    return <img className={small ? "artwork small" : "artwork"} src={song.artwork} alt="" />;
  }
  return (
    <span className={small ? "artwork fallback small" : "artwork fallback"} aria-hidden="true">
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

function PlayIcon() {
  return (
    <svg className="play-glyph play-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.3 6.55c0-1.72 1.88-2.78 3.35-1.9l7.35 4.4c1.43.86 1.43 2.94 0 3.8l-7.35 4.4c-1.47.88-3.35-.18-3.35-1.9v-8.8Z" />
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

function ReplayIcon() {
  return (
    <svg className="action-icon replay-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.2 9.2A8.5 8.5 0 1 1 3.8 15" />
      <path d="M4.2 4.5v4.7h4.7" />
    </svg>
  );
}

export default App;
