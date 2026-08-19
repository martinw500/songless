import type { Song } from "../types";

const MIN_FADE_SECONDS = 0.004;

export class AudioEngine {
  private context: AudioContext | null = null;
  private activeNodes: AudioScheduledSourceNode[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private playbackId = 0;

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
  }

  async play(song: Song, startSeconds: number, endSeconds: number, volume: number): Promise<number> {
    this.stop();
    const playbackId = this.playbackId;
    const context = await this.getContext();
    if (playbackId !== this.playbackId) return 0;
    const rangeStart = Math.max(0, startSeconds);
    const requestedDuration = Math.max(0, endSeconds - rangeStart);
    if (requestedDuration <= 0) throw new Error("The playback range must have a positive duration.");

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
    if (cached) return cached;

    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Could not load ${src} (${response.status}).`);
    }
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    this.buffers.set(src, buffer);
    return buffer;
  }
}
