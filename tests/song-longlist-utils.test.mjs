import assert from "node:assert/strict";
import test from "node:test";
import {
  languageReviewFor,
  parseCsv,
  parseFounderPlaylistExport,
} from "../scripts/song-longlist-utils.mjs";

test("language review accepts explicit classifications and applies a safe default", () => {
  assert.equal(languageReviewFor(undefined), "english");
  assert.equal(languageReviewFor(undefined, "pending"), "pending");
  assert.equal(languageReviewFor("non_english"), "non_english");
  assert.equal(languageReviewFor("multilingual"), "multilingual");
  assert.throws(() => languageReviewFor("spanish"), /Invalid languageReview/);
});

test("CSV parser handles commas, escaped quotes, and CRLF", () => {
  assert.deepEqual(parseCsv('Title,Artist\r\n"Song, One","Artist ""A"""\r\n'), [
    ["Title", "Artist"],
    ["Song, One", 'Artist "A"'],
  ]);
});

test("playlist export accepts Exportify-style headers and filters Han-script rows", () => {
  const tracks = parseFounderPlaylistExport(
    '\uFEFFTrack URI,Track Name,Artist Name(s)\nspotify:track:1,"Hurts Me","Tory Lanez, Trippie Redd, Yoko Gold"\nspotify:track:2,中文歌,歌手\n',
  );
  assert.deepEqual(tracks, [{ title: "Hurts Me", artist: "Tory Lanez, Trippie Redd, Yoko Gold" }]);
});

test("playlist export also accepts simple title and artist headers", () => {
  assert.deepEqual(parseFounderPlaylistExport("title,artist\nLove Me Not,Ravyn Lenae\n"), [
    { title: "Love Me Not", artist: "Ravyn Lenae" },
  ]);
});

test("playlist export rejects unsupported columns and malformed quoting", () => {
  assert.throws(() => parseFounderPlaylistExport("name,performer\nSong,Artist\n"), /Track Name\/Title/);
  assert.throws(() => parseCsv('title,artist\n"broken,Artist\n'), /unterminated/);
});
