import assert from "node:assert/strict";
import test from "node:test";
import { AudioEngine } from "../src/lib/audio.ts";

test("hosted reveal streams from game-time zero and responds to live volume changes", async (context) => {
  const originalAudio = globalThis.Audio;
  const originalMediaElement = globalThis.HTMLMediaElement;
  const originalAudioContext = globalThis.AudioContext;
  const originalWindow = globalThis.window;
  let media;
  let mediaGain;
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
  class MockAudioContext {
    state = "running";
    destination = {};
    async resume() {}
    createMediaElementSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      mediaGain = { gain: { value: 1 }, connect() {}, disconnect() {} };
      return mediaGain;
    }
  }
  globalThis.Audio = MockAudio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.AudioContext = MockAudioContext;
  globalThis.window = { setTimeout, clearTimeout };
  context.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.HTMLMediaElement = originalMediaElement;
    globalThis.AudioContext = originalAudioContext;
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
  assert.ok(Math.abs(await engine.playRemainder(song, 0, 0.7) - 207.6) < 0.000001);
  assert.equal(media.src, song.audio.fullSrc);
  assert.ok(Math.abs(media.currentTime - 2.4) < 0.000001);
  assert.equal(mediaGain.gain.value, 0.7);
  assert.equal(media.paused, false);
  engine.setVolume(1.6);
  assert.equal(mediaGain.gain.value, 1.6);
  assert.equal(media.paused, false);
  engine.stop();
  assert.equal(media.paused, true);
});

test("hosted clue loading retries a transient response", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  let calls = 0;
  globalThis.window = { setTimeout };
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503 };
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });

  const decoded = { duration: 30 };
  const engine = new AudioEngine();
  const buffer = await engine.loadBuffer("https://media.example/clue.mp3", {
    decodeAudioData: async () => decoded,
  });
  assert.equal(buffer, decoded);
  assert.equal(calls, 2);
});
