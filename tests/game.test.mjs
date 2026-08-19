import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAnswer, songMatchesQuery, validateCatalog } from "../src/lib/game.ts";

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
});
