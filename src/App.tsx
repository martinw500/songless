import {
  type FormEvent,
  type KeyboardEvent,
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

const initialSeen = (): Record<Difficulty, Set<string>> => ({
  easy: new Set(),
  medium: new Set(),
  hard: new Set(),
  expert: new Set(),
  impossible: new Set(),
});

function App() {
  const audioEngine = useRef(new AudioEngine());
  const seenSongs = useRef(initialSeen());
  const [catalog, setCatalog] = useState<Song[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [status, setStatus] = useState<RoundStatus>("playing");
  const [query, setQuery] = useState("");
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [guessedSongIds, setGuessedSongIds] = useState<string[]>([]);
  const [message, setMessage] = useState("Listen closely. The first clip is tiny.");
  const [audioError, setAudioError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(() => {
    const saved = Number(window.localStorage.getItem("songless-volume"));
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
    window.localStorage.setItem("songless-volume", String(volume));
  }, [volume]);

  useEffect(() => {
    audioEngine.current.stop();
    const pool = filterSongs(catalog, difficulty);
    const song = pickSong(pool, seenSongs.current[difficulty]);
    if (song) seenSongs.current[difficulty].add(song.id);
    setCurrentSong(song);
    resetRoundState();
  }, [catalog, difficulty]);

  useEffect(() => () => audioEngine.current.stop(), []);

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

  function resetRoundState() {
    setStageIndex(0);
    setStatus("playing");
    setQuery("");
    setSelectedSongId(null);
    setGuessedSongIds([]);
    setMessage("Listen closely. The first clip is tiny.");
    setAudioError("");
    setIsPlaying(false);
  }

  function startNextRound() {
    audioEngine.current.stop();
    const pool = filterSongs(catalog, difficulty);
    if (seenSongs.current[difficulty].size >= pool.length) {
      seenSongs.current[difficulty].clear();
    }
    const song = pickSong(pool, seenSongs.current[difficulty]);
    if (song) seenSongs.current[difficulty].add(song.id);
    setCurrentSong(song);
    resetRoundState();
  }

  async function playClip() {
    if (!currentSong || status !== "playing") return;
    setAudioError("");
    setIsPlaying(true);
    try {
      await audioEngine.current.play(currentSong, stages[stageIndex], volume);
      window.setTimeout(() => setIsPlaying(false), stages[stageIndex] * 1000 + 50);
    } catch (error) {
      setIsPlaying(false);
      setAudioError(error instanceof Error ? error.message : "The clip could not be played.");
    }
  }

  function advanceOrLose(reason: "skip" | "wrong") {
    audioEngine.current.stop();
    setIsPlaying(false);
    if (stageIndex < stages.length - 1) {
      const nextIndex = stageIndex + 1;
      setStageIndex(nextIndex);
      setMessage(
        reason === "skip"
          ? `Skipped. You now have ${stages[nextIndex]} seconds.`
          : `Not that one. You now have ${stages[nextIndex]} seconds.`,
      );
      return;
    }
    setStatus("lost");
    setMessage("Out of clues. The song has been revealed.");
  }

  function submitGuess(songOverride?: Song) {
    if (!currentSong || status !== "playing") return;
    const guess = songOverride ?? selectedSong;
    if (!guess) {
      setMessage("Choose a song from the search results first.");
      return;
    }

    if (guess.id === currentSong.id) {
      audioEngine.current.stop();
      setIsPlaying(false);
      setStatus("won");
      setMessage(`Correct in ${stages[stageIndex]} seconds.`);
      return;
    }

    setGuessedSongIds((ids) => [...ids, guess.id]);
    setQuery("");
    setSelectedSongId(null);
    advanceOrLose("wrong");
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    submitGuess();
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || selectedSong || suggestions.length === 0) return;
    event.preventDefault();
    submitGuess(suggestions[0]);
  }

  function selectSuggestion(song: Song) {
    setSelectedSongId(song.id);
    setQuery(`${song.title} — ${song.artist}`);
  }

  const isDemoCatalog = catalog.length > 0 && catalog.every((song) => song.audio.kind === "synth");

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Songless home">
          <span className="brand-mark" aria-hidden="true">s</span>
          <span>songless</span>
        </a>
        <div className="library-size">
          <span className="status-dot" /> {catalog.length} songs local
        </div>
      </header>

      <section className="game-layout">
        <aside className="mode-panel" aria-label="Difficulty">
          <p className="eyebrow">Difficulty</p>
          <nav className="difficulty-list">
            {difficulties.map((level) => (
              <button
                className={difficulty === level ? `difficulty ${level} active` : `difficulty ${level}`}
                disabled={catalog.length > 0 && counts[level] === 0}
                key={level}
                onClick={() => setDifficulty(level)}
                type="button"
              >
                <span>{difficultyLabels[level]}</span>
                <span className="mode-count">{counts[level]}</span>
              </button>
            ))}
          </nav>
          <div className="mode-note">
            <span>From the start</span>
            <strong>{stages.length} stages</strong>
          </div>
        </aside>

        <section className="game-card" aria-live="polite">
          <div className="difficulty-tabs" aria-hidden="true">
            {difficulties.map((level) => (
              <span className={difficulty === level ? `${level} active` : level} key={level}>
                {difficultyLabels[level]}
              </span>
            ))}
          </div>

          {catalogError ? (
            <div className="empty-state">
              <span className="empty-icon">!</span>
              <h1>Catalogue error</h1>
              <p>{catalogError}</p>
            </div>
          ) : !currentSong ? (
            <div className="empty-state">
              <span className="empty-icon">♪</span>
              <h1>{catalog.length === 0 ? "Loading catalogue…" : "No songs in this mode"}</h1>
              <p>Add a song with the “{difficulty}” difficulty to public/catalog.json.</p>
            </div>
          ) : status !== "playing" ? (
            <div className={`result-panel ${status}`}>
              <Artwork song={currentSong} />
              <p className="result-kicker">{status === "won" ? "You got it" : "The answer was"}</p>
              <h1>{currentSong.title}</h1>
              <p className="result-artist">{currentSong.artist}</p>
              <p className="result-message">{message}</p>
              <button className="primary-action compact" onClick={startNextRound} type="button">
                Next song <span aria-hidden="true">→</span>
              </button>
            </div>
          ) : (
            <>
              <div className="stage-track" aria-label={`Stage ${stageIndex + 1} of ${stages.length}`}>
                {stages.map((stage, index) => (
                  <span
                    className={index < stageIndex ? "passed" : index === stageIndex ? "current" : ""}
                    key={stage}
                  />
                ))}
              </div>

              <div className="player-area">
                <button
                  className={isPlaying ? "play-button playing" : "play-button"}
                  onClick={playClip}
                  type="button"
                  aria-label={`Play ${stages[stageIndex]} second clip`}
                >
                  <span className="play-triangle" />
                  <span className="pulse-ring" />
                </button>
                <div className="stage-time">
                  <strong>{stages[stageIndex]}</strong><span>s</span>
                </div>
              </div>

              <p className="game-message">{audioError || message}</p>

              <form className="guess-form" onSubmit={handleSubmit}>
                <div className="search-wrap">
                  <span className="search-icon" aria-hidden="true" />
                  <input
                    aria-label="Search songs"
                    autoComplete="off"
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setSelectedSongId(null);
                    }}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search songs…"
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
                <button className="guess-button" disabled={!selectedSong} type="submit">Guess</button>
                <button className="skip-button" onClick={() => advanceOrLose("skip")} type="button">
                  <span aria-hidden="true">▷|</span> Skip
                </button>
              </form>

              {guessedSongIds.length > 0 && (
                <div className="wrong-guesses">
                  {guessedSongIds.map((id, index) => {
                    const song = catalog.find((candidate) => candidate.id === id);
                    return song ? <span key={`${id}-${index}`}>× {song.title}</span> : null;
                  })}
                </div>
              )}
            </>
          )}
        </section>

        <aside className="settings-panel">
          <div>
            <p className="eyebrow">Song start</p>
            <div className="setting-value active-setting"><span>◖)))</span> From the start</div>
          </div>
          <div>
            <p className="eyebrow">Stages</p>
            <div className="stage-pills">
              {stages.map((stage, index) => (
                <span className={index === stageIndex && status === "playing" ? "active" : ""} key={stage}>
                  {stage}s
                </span>
              ))}
            </div>
          </div>
          <label className="volume-control">
            <span className="eyebrow">Volume</span>
            <div><span aria-hidden="true">◖)))</span><input min="0" max="1" step="0.01" type="range" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></div>
          </label>
        </aside>
      </section>

      {isDemoCatalog && (
        <footer className="demo-banner">
          Demo catalogue active. Try “Neon Steps” on Easy, then replace the demo entries using <code>docs/CATALOG.md</code>.
        </footer>
      )}
    </main>
  );
}

function Artwork({ song, small = false }: { song: Song; small?: boolean }) {
  if (song.artwork) {
    return <img className={small ? "artwork small" : "artwork"} src={song.artwork} alt="" />;
  }
  return (
    <span className={small ? "artwork fallback small" : "artwork fallback"} aria-hidden="true">
      ♪
    </span>
  );
}

export default App;
