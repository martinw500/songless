import assert from "node:assert/strict";
import test from "node:test";
import { AudioEngine } from "../src/lib/audio.ts";

test("hosted reveal streams the complete R2 file from the offset timestamp", async (context) => {
  const originalAudio = globalThis.Audio;
  const originalMediaElement = globalThis.HTMLMediaElement;
  const originalWindow = globalThis.window;
  let media;
  class MockAudio {
    readyState = 1;
    duration = 210;
    currentTime = 0;
    volume = 1;
    src = "";
    paused = true;
    constructor() { media = this; }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    load() {}
    addEventListener() {}
    removeEventListener() {}
  }
  globalThis.Audio = MockAudio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.window = { setTimeout, clearTimeout };
  context.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.HTMLMediaElement = originalMediaElement;
    globalThis.window = originalWindow;
  });

  const engine = new AudioEngine();
  const song = {
    id: "hosted-song",
    title: "Hosted Song",
    artist: "Test Artist",
    difficulty: "easy",
    startAtMs: 2400,
    audio: {
      kind: "hosted",
      clueSrc: "https://media.example/audio/clues/hosted-song.mp3",
      fullSrc: "https://media.example/audio/full/hosted-song.mp3",
      durationMs: 210000,
    },
  };
  assert.ok(Math.abs(await engine.playRemainder(song, 8, 0.7) - 199.6) < 0.000001);
  assert.equal(media.src, song.audio.fullSrc);
  assert.ok(Math.abs(media.currentTime - 10.4) < 0.000001);
  assert.equal(media.volume, 0.7);
  assert.equal(media.paused, false);
  engine.stop();
  assert.equal(media.paused, true);
});
