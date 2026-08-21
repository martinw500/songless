import type { Song } from "../types";

const MIN_FADE_SECONDS = 0.004;
const MAX_CACHED_BUFFERS = 3;
const SYNTH_REVEAL_SECONDS = 30;

export class AudioEngine {
  private context: AudioContext | null = null;
  private activeNodes: AudioScheduledSourceNode[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private playbackId = 0;
  private media: HTMLAudioElement | null = null;

  stop(): void {
    this.playbackId += 1;
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

    if (song.audio.kind === "file" || song.audio.kind === "hosted") {
      let sourceUrl = song.audio.kind === "file" ? song.audio.src : song.audio.clueSrc;
      // If the start time is past the end of the ~30s clue clip (e.g. when playing a hook offset), 
      // we must use the full audio track instead.
      if (song.audio.kind === "hosted" && (song.startAtMs ?? 0) > 28000) {
        sourceUrl = song.audio.fullSrc;
      }
      const buffer = await this.loadBuffer(sourceUrl, context);
      if (playbackId !== this.playbackId) return 0;
      const now = context.currentTime;
      const offset = Math.max(0, (song.startAtMs ?? 0) / 1000 + rangeStart);
      const available = Math.max(0, buffer.duration - offset);
      const actualDuration = Math.min(requestedDuration, available);
      if (actualDuration <= 0) {
        throw new Error("The configured playback range is past the end of the audio file.");
      }
      const gain = this.createGain(context, now, actualDuration, volume);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(now, offset, actualDuration);
      this.activeNodes = [source];
      return actualDuration;
    }

    const now = context.currentTime;
    const end = now + requestedDuration;
    const gain = this.createGain(context, now, requestedDuration, volume);
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

      const media = new Audio();
      media.preload = "auto";
      media.crossOrigin = "anonymous";
      
      const source = context.createMediaElementSource(media);
      const gain = context.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(context.destination);

      // Add a dummy node to disconnect the graph on stop
      const disconnectNode = {
        stop: () => {
          source.disconnect();
          gain.disconnect();
        }
      } as any;
      this.activeNodes.push(disconnectNode);

      media.src = song.audio.fullSrc;
      this.media = media;
      await this.waitForMetadata(media);
      if (playbackId !== this.playbackId || this.media !== media) return 0;
      const offset = Math.max(0, (song.startAtMs ?? 0) / 1000 + Math.max(0, startSeconds));
      const configuredDuration = song.audio.durationMs / 1000;
      const duration = Number.isFinite(media.duration) ? media.duration : configuredDuration;
      if (offset >= duration) throw new Error("The reveal starts past the end of the hosted song.");
      media.currentTime = offset;
      await media.play();
      if (playbackId !== this.playbackId || this.media !== media) {
        media.pause();
        return 0;
      }
      return duration - offset;
    }

    this.stop();
    const playbackId = this.playbackId;
    const context = await this.getContext();
    if (playbackId !== this.playbackId) return 0;
    const buffer = await this.loadBuffer(song.audio.src, context);
    if (playbackId !== this.playbackId) return 0;
    const offset = Math.max(0, (song.startAtMs ?? 0) / 1000 + Math.max(0, startSeconds));
    const actualDuration = Math.max(0, buffer.duration - offset);
    if (actualDuration <= 0) throw new Error("The reveal starts past the end of the audio file.");

    const now = context.currentTime;
    const gain = this.createGain(context, now, actualDuration, volume);
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
    volume: number,
  ): GainNode {
    const gain = context.createGain();
    const end = now + durationSeconds;
    const fade = Math.min(MIN_FADE_SECONDS, durationSeconds / 3);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + fade);
    gain.gain.setValueAtTime(volume, Math.max(now + fade, end - fade));
    gain.gain.linearRampToValueAtTime(0, end);
    gain.connect(context.destination);
    return gain;
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

    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Could not load ${src} (${response.status}).`);
    }
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
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
