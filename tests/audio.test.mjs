import assert from "node:assert/strict";
import test from "node:test";
import { AudioEngine } from "../src/lib/audio.ts";

test("hosted clues decode the compact asset and schedule an exact buffer range", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalAudio = globalThis.Audio;
  const originalAudioContext = globalThis.AudioContext;
  const originalWindow = globalThis.window;
  let mediaCreated = false;
  let fetchedUrl = "";
  let started;
  const gains = [];
  const decoded = { duration: 30 };
  class MockAudio {
    constructor() { mediaCreated = true; }
  }
  class MockAudioContext {
    state = "running";
    destination = {};
    currentTime = 1.25;
    async resume() {}
    decodeAudioData = async () => decoded;
    createBufferSource() {
      return {
        buffer: null,
        connect() {},
        start(when, offset, duration) { started = { when, offset, duration }; },
        stop() {},
      };
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
    createBiquadFilter() {
      return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect() {} };
    }
  }
  globalThis.Audio = MockAudio;
  globalThis.AudioContext = MockAudioContext;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async (url) => {
    fetchedUrl = String(url);
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  context.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.Audio = originalAudio;
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
  assert.equal(fetchedUrl, song.audio.clueSrc);
  assert.equal(mediaCreated, false);
  assert.deepEqual(started, { when: 1.25, offset: 0.585, duration: 1.5 });

  // Envelope gain is created first; the persistent master is created next and
  // is the node live volume changes must hit.
  const masterGain = gains[1];
  assert.equal(masterGain.gain.value, 0.8);
  engine.setVolume(1.6);
  assert.equal(masterGain.gain.value, 1.6);
  engine.stop();
});

test("quiet masters raise both the clue and the reveal, capped with the limiter path", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalAudio = globalThis.Audio;
  const originalMediaElement = globalThis.HTMLMediaElement;
  const originalAudioContext = globalThis.AudioContext;
  const originalWindow = globalThis.window;
  let media;
  const gains = [];
  const envelopePeaks = [];
  const decoded = { duration: 30 };
  class MockAudio {
    readyState = 1;
    duration = 210;
    currentTime = 0;
    src = "";
    paused = true;
    constructor() { media = this; }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    setAttribute() {}
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
    decodeAudioData = async () => decoded;
    createBufferSource() {
      return { buffer: null, connect() {}, start() {}, stop() {} };
    }
    createMediaElementSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      const node = {
        gain: {
          value: 1,
          setValueAtTime(value) { this.value = value; },
          linearRampToValueAtTime(value) { this.value = value; envelopePeaks.push(value); },
        },
        connect() {},
        disconnect() {},
      };
      gains.push(node);
      return node;
    }
    createDynamicsCompressor() {
      return {
        threshold: { value: 0 },
        knee: { value: 0 },
        ratio: { value: 0 },
        attack: { value: 0 },
        release: { value: 0 },
        connect() {},
      };
    }
    createBiquadFilter() {
      return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect() {} };
    }
  }
  globalThis.Audio = MockAudio;
  globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
  globalThis.AudioContext = MockAudioContext;
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
  context.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.Audio = originalAudio;
    globalThis.HTMLMediaElement = originalMediaElement;
    globalThis.AudioContext = originalAudioContext;
    globalThis.window = originalWindow;
  });

  const engine = new AudioEngine();
  const song = {
    id: "billie-eilish-wildflower",
    title: "WILDFLOWER",
    artist: "Billie Eilish",
    difficulty: "medium",
    playbackGainDb: 12,
    startAtMs: 240,
    audio: {
      kind: "hosted",
      clueSrc: "https://media.example/audio/clues/wildflower.mp3",
      fullSrc: "https://media.example/audio/full/wildflower.mp3",
      durationMs: 261213,
    },
  };
  await engine.play(song, 0, 0.1, 1);
  const boosted = 10 ** (12 / 20);
  assert.ok(envelopePeaks.includes(boosted), `clue envelope never reached +12 dB (${JSON.stringify(envelopePeaks)})`);

  gains.length = 0;
  await engine.playRemainder(song, 0, 1);
  const revealGain = gains[0];
  assert.ok(Math.abs(revealGain.gain.value - boosted) < 0.0001);
  assert.equal(media.src, song.audio.fullSrc);
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
    playsInline = false;
    constructor() { media = this; }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    setAttribute() {}
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
    createBiquadFilter() {
      return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect() {} };
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
