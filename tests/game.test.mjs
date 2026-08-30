import assert from "node:assert/strict";
import test from "node:test";
import {
  filterSongs,
  genreGroups,
  normalizeAnswer,
  pickSongFromCycle,
  songMatchesQuery,
  validateCatalog,
} from "../src/lib/game.ts";

const internationalSongs = [
  {
    id: "stromae-alors-on-danse",
    title: "Alors on danse",
    artist: "Stromae",
    aliases: [],
    artistAliases: [],
    difficulty: "easy",
    familiarity: 90,
    audio: { kind: "synth", notes: [440] },
  },
  {
    id: "indila-derniere-danse",
    title: "Dernière danse",
    artist: "Indila",
    aliases: ["Derniere danse"],
    artistAliases: [],
    difficulty: "easy",
    familiarity: 90,
    audio: { kind: "synth", notes: [440] },
  },
  {
    id: "psy-gangnam-style",
    title: "강남스타일",
    artist: "PSY",
    aliases: ["Gangnam Style"],
    artistAliases: ["싸이"],
    difficulty: "easy",
    familiarity: 90,
    audio: { kind: "synth", notes: [440] },
  },
  {
    id: "rose-apt",
    title: "APT.",
    artist: "ROSÉ & Bruno Mars",
    aliases: ["Apateu"],
    artistAliases: ["Rose and Bruno Mars"],
    difficulty: "easy",
    familiarity: 90,
    audio: { kind: "synth", notes: [440] },
  },
];

test("normalization preserves Unicode letters and removes accents", () => {
  assert.equal(normalizeAnswer("Dernière danse"), "derniere danse");
  assert.equal(normalizeAnswer("강남스타일"), "강남스타일");
  assert.equal(normalizeAnswer("ROSÉ & Bruno Mars"), "rose and bruno mars");
});

test("search accepts canonical, accented, romanized, and artist aliases", () => {
  assert.equal(songMatchesQuery(internationalSongs[0], "alors"), true);
  assert.equal(songMatchesQuery(internationalSongs[1], "derniere"), true);
  assert.equal(songMatchesQuery(internationalSongs[2], "강남"), true);
  assert.equal(songMatchesQuery(internationalSongs[2], "gangnam"), true);
  assert.equal(songMatchesQuery(internationalSongs[3], "rose and bruno"), true);
});

test("featured-artist and version suffix normalization remains intact", () => {
  assert.equal(normalizeAnswer("Song (Remastered)"), "song");
  assert.equal(normalizeAnswer("Song feat. Guest"), "song");
});

test("catalogue validation accepts complete R2 hosted sources", () => {
  const valid = {
    ...internationalSongs[0],
    startAtMs: 2400,
    audio: {
      kind: "hosted",
      clueSrc: "https://media.example.com/audio/clues/song.mp3",
      fullSrc: "https://media.example.com/audio/full/song.mp3",
      durationMs: 210000,
    },
  };
  assert.deepEqual(validateCatalog([valid]), [valid]);
  assert.deepEqual(validateCatalog([{ ...valid, audio: { ...valid.audio, clueSrc: "/audio/clue.mp3" } }]), []);
  assert.deepEqual(validateCatalog([{ ...valid, startAtMs: -1 }]), []);
  assert.deepEqual(validateCatalog([{ ...valid, clueGainDb: 8 }]), [{ ...valid, clueGainDb: 8 }]);
  assert.deepEqual(validateCatalog([{ ...valid, clueGainDb: 13 }]), []);
  assert.deepEqual(validateCatalog([{ ...valid, playbackGainDb: 12 }]), [{ ...valid, playbackGainDb: 12 }]);
  assert.deepEqual(validateCatalog([{ ...valid, playbackGainDb: 13 }]), []);
});

test("era and broad genre filters compose with difficulty", () => {
  const songs = [
    { ...internationalSongs[0], releaseYear: 2024, genres: ["dance-pop"] },
    { ...internationalSongs[1], id: "classic-rock", releaseYear: 1985, genres: ["alternative rock"] },
    { ...internationalSongs[1], id: "2010s-pop", releaseYear: 2016, genres: ["pop"] },
    { ...internationalSongs[2], id: "old-medium", difficulty: "medium", releaseYear: 1985, genres: ["rock"] },
  ];
  assert.deepEqual(filterSongs(songs, "easy", { era: "modern", genre: "dance" }).map((song) => song.id), [
    "stromae-alors-on-danse",
  ]);
  assert.deepEqual(filterSongs(songs, "easy", { era: "classics", genre: "rock" }).map((song) => song.id), [
    "classic-rock",
  ]);
  assert.deepEqual(filterSongs(songs, "easy", {
    era: ["modern", "2010s"],
    genre: ["pop", "dance"],
  }).map((song) => song.id), ["stromae-alors-on-danse", "2010s-pop"]);
  assert.equal(filterSongs(songs, "easy", { era: [], genre: [] }).length, 3);
  assert.deepEqual([...genreGroups({ ...internationalSongs[0], genres: ["indie pop"] })].sort(), ["pop", "rock"]);
});

test("persistent draw cycles exhaust a pool before repeating and avoid the last song on reset", () => {
  const songs = ["one", "two", "three"].map((id) => ({ ...internationalSongs[0], id }));
  let seenIds = [];
  const drawn = [];
  for (let draw = 0; draw < songs.length; draw += 1) {
    const result = pickSongFromCycle(songs, seenIds, drawn.at(-1));
    assert.ok(result.song);
    drawn.push(result.song.id);
    seenIds = result.seenIds;
  }
  assert.equal(new Set(drawn).size, songs.length);
  const next = pickSongFromCycle(songs, seenIds, drawn.at(-1));
  assert.ok(next.song);
  assert.notEqual(next.song.id, drawn.at(-1));
});
