import type { Song } from "../types";

const MIN_FADE_SECONDS = 0.004;
const MAX_CACHED_BUFFERS = 3;
const SYNTH_REVEAL_SECONDS = 30;
const BUFFER_RETRY_DELAYS_MS = [0, 350, 900] as const;

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private activeNodes: AudioScheduledSourceNode[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private playbackId = 0;
  private media: HTMLAudioElement | null = null;
  private mediaStopTimer: number | null = null;
  private volume = 1;

  setVolume(volume: number): void {
    this.volume = Math.min(5, Math.max(0, Number.isFinite(volume) ? volume : 1));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
  }

  stop(): void {
    this.playbackId += 1;
    if (this.mediaStopTimer !== null) {
      window.clearTimeout(this.mediaStopTimer);
      this.mediaStopTimer = null;
    }
    for (const node of this.activeNodes) {
      try {
        node.stop();
      } catch {
        // A node that already ended can safely be ignored.
      }
    }
    this.activeNodes = [];
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute("src");
      this.media.load();
      this.media = null;
    }
  }

  async play(song: Song, startSeconds: number, endSeconds: number, volume: number): Promise<number> {
    this.stop();
    const playbackId = this.playbackId;
    const rangeStart = Math.max(0, startSeconds);
    const requestedDuration = Math.max(0, endSeconds - rangeStart);
    if (requestedDuration <= 0) throw new Error("The playback range must have a positive duration.");

    const context = await this.getContext();
    if (playbackId !== this.playbackId) return 0;
    this.setVolume(volume);

    if (song.audio.kind === "hosted") {
      const sourceUrl = (song.startAtMs ?? 0) > 28000 ? song.audio.fullSrc : song.audio.clueSrc;
      return this.playHostedRange(song, sourceUrl, rangeStart, requestedDuration, context, playbackId);
    }

    if (song.audio.kind === "file") {
      const buffer = await this.loadBuffer(song.audio.src, context);
      if (playbackId !== this.playbackId) return 0;
      const now = context.currentTime;
      const offset = Math.max(0, (song.startAtMs ?? 0) / 1000 + rangeStart);
      const available = Math.max(0, buffer.duration - offset);
      const actualDuration = Math.min(requestedDuration, available);
      if (actualDuration <= 0) {
        throw new Error("The configured playback range is past the end of the audio file.");
      }
      const gain = this.createGain(context, now, actualDuration, song.clueGainDb ?? 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(now, offset, actualDuration);
      this.activeNodes = [source];
      return actualDuration;
    }

    const now = context.currentTime;
    const end = now + requestedDuration;
    const gain = this.createGain(context, now, requestedDuration);
    const noteLength = Math.max(0.08, (song.audio.noteLengthMs ?? 350) / 1000);
    const notes = song.audio.notes.length > 0 ? song.audio.notes : [440];
    let cursor = now;
    let noteIndex = Math.floor(rangeStart / noteLength);
    const nodes: OscillatorNode[] = [];

    while (cursor < end) {
      const oscillator = context.createOscillator();
      const noteGain = context.createGain();
      const noteEnd = Math.min(cursor + noteLength * 0.88, end);
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(notes[noteIndex % notes.length], cursor);
      noteGain.gain.setValueAtTime(0, cursor);
      noteGain.gain.linearRampToValueAtTime(0.7, cursor + 0.008);
      noteGain.gain.exponentialRampToValueAtTime(0.001, noteEnd);
      oscillator.connect(noteGain);
      noteGain.connect(gain);
      oscillator.start(cursor);
      oscillator.stop(noteEnd);
      nodes.push(oscillator);
      cursor += noteLength;
      noteIndex += 1;
    }

    this.activeNodes = nodes;
    return requestedDuration;
  }

  async playRemainder(song: Song, startSeconds: number, volume: number): Promise<number> {
    if (song.audio.kind === "synth") {
      return this.play(song, startSeconds, startSeconds + SYNTH_REVEAL_SECONDS, volume);
    }

    if (song.audio.kind === "hosted") {
      this.stop();
      const playbackId = this.playbackId;
      const context = await this.getContext();
      if (playbackId !== this.playbackId) return 0;
      this.setVolume(volume);
      return this.playHostedRange(
        song,
        song.audio.fullSrc,
        Math.max(0, startSeconds),
        null,
        context,
        playbackId,
      );
    }

    this.stop();
    const playbackId = this.playbackId;
    const context = await this.getContext();
    if (playbackId !== this.playbackId) return 0;
    this.setVolume(volume);
    const buffer = await this.loadBuffer(song.audio.src, context);
    if (playbackId !== this.playbackId) return 0;
    const offset = Math.max(0, (song.startAtMs ?? 0) / 1000 + Math.max(0, startSeconds));
    const actualDuration = Math.max(0, buffer.duration - offset);
    if (actualDuration <= 0) throw new Error("The reveal starts past the end of the audio file.");

    const now = context.currentTime;
    const gain = this.createGain(context, now, actualDuration);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(now, offset, actualDuration);
    this.activeNodes = [source];
    return actualDuration;
  }

  private createGain(
    context: AudioContext,
    now: number,
    durationSeconds: number,
    boostDb = 0,
  ): GainNode {
    const gain = context.createGain();
    const adjustedVolume = 10 ** (Math.max(0, boostDb) / 20);
    const end = now + durationSeconds;
    const fade = Math.min(MIN_FADE_SECONDS, durationSeconds / 3);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(adjustedVolume, now + fade);
    gain.gain.setValueAtTime(adjustedVolume, Math.max(now + fade, end - fade));
    gain.gain.linearRampToValueAtTime(0, end);
    if (boostDb > 0) {
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -4;
      limiter.knee.value = 2;
      limiter.ratio.value = 16;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.18;
      gain.connect(limiter);
      limiter.connect(this.getMasterGain(context));
    } else {
      gain.connect(this.getMasterGain(context));
    }
    return gain;
  }

  private createMediaGain(context: AudioContext, boostDb = 0): AudioNode {
    if (boostDb <= 0) return this.getMasterGain(context);
    const gain = context.createGain();
    gain.gain.value = 10 ** (Math.max(0, boostDb) / 20);
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    gain.connect(limiter);
    limiter.connect(this.getMasterGain(context));
    return gain;
  }

  private async playHostedRange(
    song: Song,
    src: string,
    rangeStart: number,
    requestedDuration: number | null,
    context: AudioContext,
    playbackId: number,
  ): Promise<number> {
    if (song.audio.kind !== "hosted") throw new Error("Hosted playback requires a hosted audio source.");
    const media = new Audio();
    media.preload = "auto";
    media.crossOrigin = "anonymous";
    media.src = src;
    this.media = media;
    await this.waitForMetadata(media);
    if (playbackId !== this.playbackId || this.media !== media) return 0;

    // Safari can suspend Web Audio while metadata is loading. Once the Play
    // gesture has unlocked it, resume again before connecting the media node.
    if (context.state !== "running") await context.resume();
    if (playbackId !== this.playbackId || this.media !== media) return 0;

    const offset = Math.max(0, (song.startAtMs ?? 0) / 1000 + rangeStart);
    const configuredDuration = song.audio.durationMs / 1000;
    const mediaDuration = Number.isFinite(media.duration) ? media.duration : configuredDuration;
    const available = Math.max(0, mediaDuration - offset);
    const actualDuration = requestedDuration === null ? available : Math.min(requestedDuration, available);
    if (actualDuration <= 0) throw new Error("The configured playback range is past the end of the hosted song.");

    media.currentTime = offset;
    const source = context.createMediaElementSource(media);
    source.connect(this.createMediaGain(context, requestedDuration === null ? 0 : song.clueGainDb ?? 0));
    this.activeNodes.push({ stop: () => source.disconnect() } as AudioScheduledSourceNode);
    await media.play();
    if (playbackId !== this.playbackId || this.media !== media) {
      media.pause();
      return 0;
    }
    if (requestedDuration !== null) {
      this.mediaStopTimer = window.setTimeout(() => {
        if (playbackId !== this.playbackId || this.media !== media) return;
        this.mediaStopTimer = null;
        media.pause();
      }, actualDuration * 1000);
    }
    return actualDuration;
  }

  private getMasterGain(context: AudioContext): GainNode {
    if (!this.masterGain) {
      this.masterGain = context.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(context.destination);
    }
    return this.masterGain;
  }

  private async getContext(): Promise<AudioContext> {
    this.context ??= new AudioContext();
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
    return this.context;
  }

  private async loadBuffer(src: string, context: AudioContext): Promise<AudioBuffer> {
    const cached = this.buffers.get(src);
    if (cached) {
      this.buffers.delete(src);
      this.buffers.set(src, cached);
      return cached;
    }

    let buffer: AudioBuffer | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < BUFFER_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = BUFFER_RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      try {
        const response = await fetch(src);
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 425 || response.status === 429
            || response.status >= 500;
          const error = new Error(`Could not load ${src} (${response.status}).`);
          if (!retryable) throw error;
          lastError = error;
          continue;
        }
        buffer = await context.decodeAudioData(await response.arrayBuffer());
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!buffer) {
      throw lastError instanceof Error ? lastError : new Error(`Could not decode ${src}.`);
    }
    this.buffers.set(src, buffer);
    while (this.buffers.size > MAX_CACHED_BUFFERS) {
      const oldest = this.buffers.keys().next().value;
      if (oldest === undefined) break;
      this.buffers.delete(oldest);
    }
    return buffer;
  }

  private async waitForMetadata(media: HTMLAudioElement): Promise<void> {
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => finish(new Error("The hosted song metadata timed out.")), 15_000);
      const finish = (error?: Error) => {
        window.clearTimeout(timeout);
        media.removeEventListener("loadedmetadata", loaded);
        media.removeEventListener("error", failed);
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error("The hosted song could not be loaded."));
      media.addEventListener("loadedmetadata", loaded, { once: true });
      media.addEventListener("error", failed, { once: true });
      media.load();
    });
  }
}
