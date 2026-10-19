import { useState } from "react";
import { Clapperboard } from "lucide-react";
import type { AspectFormat, CreateRenderRequest, ProviderStatusDto, Quality, Storyboard } from "@atlas/shared";
import { Button, Card, Checkbox, Field, Segmented } from "../../components/ui";

const QUALITY_HELP: Record<Quality, string> = {
  draft: "Half resolution, fast encode. Good for checking timing.",
  standard: "Full 1080p, balanced encode.",
  high: "Full 1080p, slower encode with higher bitrate.",
};

export function RenderSettingsForm({ storyboard, version, providers, busy, onSubmit }: { storyboard: Storyboard; version: number; providers: ProviderStatusDto[]; busy: boolean; onSubmit: (req: CreateRenderRequest) => void }) {
  const [formats, setFormats] = useState<AspectFormat[]>(storyboard.formats);
  const [fps, setFps] = useState<24 | 25 | 30>(storyboard.fps);
  const [quality, setQuality] = useState<Quality>("standard");
  const [subtitles, setSubtitles] = useState<"burned" | "sidecar" | "none">("burned");
  const hasNarrationText = storyboard.scenes.some((s) => s.narration.trim());
  const voice = providers.find((p) => p.kind === "tts" && p.configured && p.languages?.includes(storyboard.language));
  const [narration, setNarration] = useState(hasNarrationText && !!voice);
  const [ambience, setAmbience] = useState(false);
  const toggle = (f: AspectFormat) => setFormats((cur) => (cur.includes(f) ? (cur.length > 1 ? cur.filter((x) => x !== f) : cur) : [...cur, f]));
  const totalFrames = storyboard.scenes.reduce((n, s) => n + Math.round(s.durationSeconds * fps), 0) * formats.length;

  return (
    <Card className="space-y-5 p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Formats">
          <div className="flex flex-col gap-2 pt-1">
            <Checkbox label="9:16 vertical" checked={formats.includes("9:16")} onChange={() => toggle("9:16")} hint="1080×1920 (540×960 in draft)" />
            <Checkbox label="16:9 widescreen" checked={formats.includes("16:9")} onChange={() => toggle("16:9")} hint="1920×1080 (960×540 in draft)" />
          </div>
        </Field>
        <div className="space-y-4">
          <Field label="Frame rate">
            <Segmented label="Frame rate" value={fps} onChange={setFps} options={[24, 25, 30].map((v) => ({ value: v as 24 | 25 | 30, label: `${v} fps` }))} />
          </Field>
          <Field label="Quality" hint={QUALITY_HELP[quality]}>
            <Segmented label="Quality" value={quality} onChange={setQuality} options={[{ value: "draft", label: "Draft" }, { value: "standard", label: "Standard" }, { value: "high", label: "High" }]} />
          </Field>
        </div>
        <Field label="Subtitles" hint={subtitles === "burned" ? "Drawn into the video, plus an .srt file." : subtitles === "sidecar" ? "Separate .srt file and a soft subtitle track." : "No captions."}>
          <Segmented label="Subtitles" value={subtitles} onChange={setSubtitles} options={[{ value: "burned", label: "Burned in" }, { value: "sidecar", label: "Separate file" }, { value: "none", label: "None" }]} />
        </Field>
        <div className="space-y-3 pt-1">
          <Checkbox
            label="Narration"
            checked={narration}
            onChange={setNarration}
            disabled={!hasNarrationText || !voice}
            hint={!hasNarrationText ? "No scene has narration text." : voice ? `${voice.label}. Synthetic voice.` : "No voice for this language is configured on the server."}
          />
          <Checkbox label="Ambience bed" checked={ambience} onChange={setAmbience} hint="Generated low drone, mixed under narration." />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-xs text-faint">
          {totalFrames.toLocaleString()} frames to draw. Renders storyboard version {version}; later edits will not change this render.
        </p>
        <Button
          variant="primary"
          busy={busy}
          icon={<Clapperboard className="size-4" />}
          onClick={() => onSubmit({ formats, fps, quality, subtitles, narration, ambience, storyboardVersion: version })}
        >
          Start render
        </Button>
      </div>
    </Card>
  );
}
