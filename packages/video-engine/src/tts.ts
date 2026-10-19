import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type { Language } from "@atlas/shared";
import { assertSafePath, CancelledError, probeMedia } from "./ffmpeg.js";

export interface SynthesizeInput {
  text: string;
  language: Language;
  /** Absolute .wav output path. */
  output: string;
  signal?: AbortSignal;
}

export interface SynthesizeResult {
  output: string;
  durationSeconds: number;
  provider: string;
  voice: string;
  license: string;
}

export interface TtsProvider {
  readonly id: string;
  readonly label: string;
  readonly languages: Language[];
  /** Voice identity; part of the audio cache key. */
  voiceFor(language: Language): string;
  isConfigured(): boolean;
  synthesize(input: SynthesizeInput): Promise<SynthesizeResult>;
}

export class TtsError extends Error {
  constructor(message: string, public readonly recoverable: boolean) {
    super(message);
    this.name = "TtsError";
  }
}

/**
 * Local speech synthesis with eSpeak NG (GPL-3.0 program; the generated audio
 * is not restricted by it). Supports Hindi and English. The voice is clearly
 * synthetic: suitable for drafts and timing, not broadcast narration.
 */
export class EspeakTtsProvider implements TtsProvider {
  readonly id = "espeak-ng";
  readonly label = "eSpeak NG (local, robotic voice)";
  readonly languages: Language[] = ["hi", "en"];
  private available: boolean | null = null;

  constructor(private readonly bin = process.env.ESPEAK_PATH || "espeak-ng") {}

  voiceFor(language: Language): string {
    return language === "hi" ? "hi" : "en-us";
  }

  isConfigured(): boolean {
    if (this.available === null) {
      const r = spawnSync(this.bin, ["--version"], { encoding: "utf8" });
      this.available = r.status === 0;
    }
    return this.available;
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    if (!this.isConfigured()) throw new TtsError("espeak-ng is not installed on the worker host.", false);
    const text = input.text.replace(/\s+/g, " ").trim();
    if (!text) throw new TtsError("Narration text is empty.", false);
    const voice = this.voiceFor(input.language);
    const tmp = `${input.output}.partial.wav`;
    await new Promise<void>((resolve, reject) => {
      if (input.signal?.aborted) return reject(new CancelledError());
      // Text goes in on stdin, never as an argument.
      const child = spawn(this.bin, ["-v", voice, "-s", input.language === "hi" ? "140" : "155", "-w", assertSafePath(tmp), "--stdin"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const onAbort = () => child.kill("SIGKILL");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => reject(new TtsError(`Could not start espeak-ng: ${e.message}`, false)));
      child.on("close", (code) => {
        input.signal?.removeEventListener("abort", onAbort);
        if (input.signal?.aborted) return reject(new CancelledError());
        if (code === 0) resolve();
        else reject(new TtsError(`espeak-ng failed (${code}): ${stderr.slice(0, 300)}`, true));
      });
      child.stdin.end(text, "utf8");
    });
    const info = await probeMedia(tmp, input.signal);
    if (!info.audio || info.durationSeconds <= 0) {
      fs.rmSync(tmp, { force: true });
      throw new TtsError("espeak-ng produced no audio.", true);
    }
    fs.renameSync(tmp, input.output);
    return { output: input.output, durationSeconds: info.durationSeconds, provider: this.id, voice, license: "Generated locally with eSpeak NG" };
  }
}

export class TtsRegistry {
  constructor(readonly providers: TtsProvider[]) {}

  /** The first configured provider that supports the language, or undefined. */
  pick(language: Language, preferred?: string): TtsProvider | undefined {
    const ok = this.providers.filter((p) => p.isConfigured() && p.languages.includes(language));
    return ok.find((p) => p.id === preferred) ?? ok[0];
  }
}
