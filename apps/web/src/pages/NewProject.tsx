import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { VISUAL_STYLES, type AspectFormat, type Language, type VisualStyle } from "@atlas/shared";
import { Button, Card, Checkbox, Field, Input, Notice, Segmented, Select, Textarea } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { keys, useProviders } from "../hooks/queries";
import { api, ApiError } from "../services/api";

const EXAMPLES: { lang: Language; text: string }[] = [
  { lang: "en", text: "Show how the Koshi, Gandaki and Karnali rivers flow from Nepal into India and join the Ganga, ending at the Bay of Bengal." },
  { lang: "hi", text: "नेपाल से भारत में बहने वाली कोसी, गंडक और करनाली नदियों को दिखाइए, जो आगे चलकर गंगा में मिलती हैं।" },
  { lang: "en", text: "A tour of the capitals around the Mediterranean Sea: Rome, Athens, Cairo and Madrid." },
];

const STYLE_LABELS: Record<VisualStyle, string> = { documentary: "Documentary", news: "News", educational: "Educational", minimal: "Minimal" };

export function NewProjectPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const providers = useProviders();
  const planners = providers.data?.filter((p) => p.kind === "planner") ?? [];
  const tts = providers.data?.filter((p) => p.kind === "tts") ?? [];

  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [duration, setDuration] = useState(60);
  const [formats, setFormats] = useState<AspectFormat[]>(["9:16", "16:9"]);
  const [style, setStyle] = useState<VisualStyle>("documentary");
  const [narration, setNarration] = useState(true);
  const [subtitles, setSubtitles] = useState(true);
  const [soundDesign, setSoundDesign] = useState(false);
  const [sources, setSources] = useState("");
  const [planner, setPlanner] = useState<string>("");
  const [stage, setStage] = useState<"idle" | "creating" | "planning">("idle");
  const [error, setError] = useState<unknown>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const chosenPlanner = planners.find((p) => p.id === planner) ?? planners.find((p) => p.isDefault);
  const ttsForLang = tts.some((p) => p.configured && p.languages?.includes(language));
  const sourceUrls = sources.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const badUrls = sourceUrls.filter((u) => !/^https?:\/\/\S+\.\S+/.test(u));

  const toggleFormat = (f: AspectFormat) => setFormats((cur) => (cur.includes(f) ? (cur.length > 1 ? cur.filter((x) => x !== f) : cur) : [...cur, f]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      let id = createdId;
      if (!id) {
        setStage("creating");
        const { project } = await api.createProject({
          prompt,
          title: title.trim() || undefined,
          options: { language, durationSeconds: duration, formats, style, narration, subtitles, soundDesign, sourceUrls },
        });
        id = project.id;
        setCreatedId(id);
        void qc.invalidateQueries({ queryKey: ["projects"] });
      } else {
        // Keep the saved project in step with any prompt edits made before retrying.
        await api.updateProject(id, { prompt, title: title.trim() || undefined, options: { language, durationSeconds: duration, formats, style, narration, subtitles, soundDesign, sourceUrls } });
      }
      setStage("planning");
      const sb = await api.generateStoryboard(id, planner || undefined);
      qc.setQueryData(keys.storyboard(id), sb);
      navigate(`/projects/${id}/storyboard`);
    } catch (err) {
      setError(err);
      setStage("idle");
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-xl font-semibold">New map video</h1>
      <p className="mt-1 text-sm text-muted">Describe the story. You will review and edit every scene before anything is rendered.</p>

      <form onSubmit={submit} className="mt-6 space-y-6">
        <Card className="space-y-5 p-5">
          <Field label="What should the video show?" htmlFor="prompt" hint={`${prompt.length}/4000. Name real places; the planner matches them against the Natural Earth gazetteer.`}>
            <Textarea id="prompt" rows={5} required minLength={10} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Show how the Koshi river flows from Nepal into Bihar and joins the Ganga" />
          </Field>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.text}
                type="button"
                className="rounded-full border border-line px-3 py-1 text-left text-xs text-muted hover:border-line-strong hover:text-fg"
                onClick={() => {
                  setPrompt(ex.text);
                  setLanguage(ex.lang);
                }}
              >
                {ex.text.length > 60 ? `${ex.text.slice(0, 60)}…` : ex.text}
              </button>
            ))}
          </div>
          <Field label="Title (optional)" htmlFor="title" hint="Defaults to the first sentence of the prompt.">
            <Input id="title" maxLength={140} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </Card>

        <Card className="grid gap-5 p-5 sm:grid-cols-2">
          <Field label="Language">
            <Segmented label="Language" value={language} onChange={setLanguage} options={[{ value: "en", label: "English" }, { value: "hi", label: "हिन्दी Hindi" }]} />
          </Field>
          <Field label={`Target length: ${duration}s`} htmlFor="duration" hint="10 to 180 seconds.">
            <input id="duration" type="range" min={10} max={180} step={5} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
          </Field>
          <Field label="Formats">
            <div className="flex gap-4 pt-1">
              <Checkbox label="9:16 vertical (1080×1920)" checked={formats.includes("9:16")} onChange={() => toggleFormat("9:16")} />
              <Checkbox label="16:9 wide (1920×1080)" checked={formats.includes("16:9")} onChange={() => toggleFormat("16:9")} />
            </div>
          </Field>
          <Field label="Visual style" htmlFor="style">
            <Select id="style" value={style} onChange={(e) => setStyle(e.target.value as VisualStyle)}>
              {VISUAL_STYLES.map((s) => (
                <option key={s} value={s}>
                  {STYLE_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-3 sm:col-span-2">
            <Checkbox label="Narration" checked={narration} onChange={setNarration} hint={ttsForLang ? "Synthetic voice (espeak-ng) generated on the render worker." : "No voice for this language is configured on the server; you can still render without narration."} />
            <Checkbox label="Subtitles" checked={subtitles} onChange={setSubtitles} />
            <Checkbox label="Ambience bed" checked={soundDesign} onChange={setSoundDesign} hint="A generated low drone under the narration. No third-party music is included." />
          </div>
        </Card>

        <Card className="space-y-5 p-5">
          <Field label="Source links (optional)" htmlFor="sources" hint="One URL per line. They are attached to the storyboard as references you can cite on claims; the server does not fetch them." error={badUrls.length ? `Not a valid http(s) link: ${badUrls[0]}` : undefined}>
            <Textarea id="sources" rows={3} value={sources} onChange={(e) => setSources(e.target.value)} placeholder="https://…" />
          </Field>
          {planners.length > 0 && (
            <Field label="Storyboard planner" htmlFor="planner">
              <Select id="planner" value={planner} onChange={(e) => setPlanner(e.target.value)}>
                <option value="">Server default ({planners.find((p) => p.isDefault)?.label ?? "auto"})</option>
                {planners.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.label}
                    {p.configured ? "" : " (not configured)"}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {chosenPlanner && <Notice tone={chosenPlanner.id === "gazetteer" ? "info" : "ok"}>{chosenPlanner.notes}</Notice>}
        </Card>

        {error ? (
          <ErrorNotice
            error={error}
            title={createdId ? "The project was saved, but planning failed" : undefined}
          />
        ) : null}
        {error instanceof ApiError && error.code === "no_places" && <p className="text-sm text-muted">Try naming specific countries, rivers, lakes or cities.</p>}

        <div className="flex items-center justify-end gap-3">
          {createdId && (
            <Button type="button" variant="ghost" onClick={() => navigate(`/projects/${createdId}/storyboard`)}>
              Open project without a storyboard
            </Button>
          )}
          <Button type="submit" variant="primary" busy={stage !== "idle"} disabled={prompt.trim().length < 10 || badUrls.length > 0} icon={<Sparkles className="size-4" />}>
            {stage === "creating" ? "Saving project…" : stage === "planning" ? "Planning storyboard…" : createdId ? "Retry planning" : "Create and plan storyboard"}
          </Button>
        </div>
      </form>
    </div>
  );
}
