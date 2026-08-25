import assert from "node:assert/strict";
import test from "node:test";
import { AudioEngine } from "../src/lib/audio.ts";

test("hosted clues use the media playback route with exact offsets and timed cutoffs", async (context) => {
  const originalAudio = globalThis.Audio;
  const originalMediaElement = globalThis.HTMLMediaElement;
  const originalAudioContext = globalThis.AudioContext;
  const originalWindow = globalThis.window;
  let media;
  let disconnected = false;
  let cutoffMs;
  let cutoffScheduledAtMediaTime;
  const gains = [];
  // A phone accepts play() well before its decoder and audio session produce
  // sound. This element mimics that: the clock only starts on the third frame.
  const framesBeforeOutput = 3;
  const outputStepSeconds = 0.02;
  let frames = 0;
  class MockAudio {
    readyState = 1;
    duration = 30;
    currentTime = 0;
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
    currentTime = 0;
    async resume() {}
    createMediaElementSource() {
      return { connect() {}, disconnect() { disconnected = true; } };
    }
    createGain() {
      const node = {
        gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
      gains.push(node);
      return node;
    }
  }
  globalThis.Audio = MockAudio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.AudioContext = MockAudioContext;
  globalThis.window = {
    setTimeout(_callback, delayMs) {
      cutoffMs = delayMs;
      cutoffScheduledAtMediaTime = media.currentTime;
      return 17;
    },
    clearTimeout() {},
    requestAnimationFrame(callback) {
      setImmediate(() => {
        frames += 1;
        if (frames >= framesBeforeOutput) media.currentTime += outputStepSeconds;
        callback();
      });
      return frames + 1;
    },
    cancelAnimationFrame() {},
  };
  context.after(() => {
    globalThis.Audio = originalAudio;
    globalThis.HTMLMediaElement = originalMediaElement;
    globalThis.AudioContext = originalAudioContext;
    globalThis.window = originalWindow;
  });

  const engine = new AudioEngine();
  const song = {
    id: "hosted-clue",
    title: "Hosted Clue",
    artist: "Test Artist",
    difficulty: "easy",
    startAtMs: 85,
    audio: {
      kind: "hosted",
      clueSrc: "https://media.example/audio/clues/hosted-clue.mp3",
      fullSrc: "https://media.example/audio/full/hosted-clue.mp3",
      durationMs: 210000,
    },
  };
  assert.equal(await engine.play(song, 0.5, 2, 0.8), 1.5);
  assert.equal(media.src, song.audio.clueSrc);
  assert.equal(media.paused, false);

  // The clue window must open on the media clock, not when play() returns.
  // Timing it from play() would let the window expire during decoder startup,
  // which is silent on a phone and inaudible on the shortest stages.
  assert.ok(frames >= framesBeforeOutput, "the engine must wait for the element to actually start");
  assert.ok(
    cutoffScheduledAtMediaTime > 0.585,
    `the cutoff must be scheduled only once audio exists, but it was scheduled at ${cutoffScheduledAtMediaTime}`,
  );
  // Whatever the element already played counts against the clue, so the
  // remaining window shortens rather than the clue running long.
  const alreadyHeardMs = Math.round((media.currentTime - 0.585) * 1000);
  assert.ok(
    Math.abs(cutoffMs - (1500 - alreadyHeardMs + 60)) < 1,
    `the cutoff should cover the unheard remainder, but it was ${cutoffMs}ms after ${alreadyHeardMs}ms played`,
  );

  const masterGain = gains[0];
  assert.equal(masterGain.gain.value, 0.8);
  engine.setVolume(1.6);
  assert.equal(masterGain.gain.value, 1.6);
  assert.equal(media.paused, false);
  engine.stop();
  assert.equal(media.paused, true);
  assert.equal(disconnected, true);
});

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
