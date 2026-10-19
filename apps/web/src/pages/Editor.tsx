import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Clapperboard, Pause, Play, Redo2, Save, Sparkles, Undo2 } from "lucide-react";
import { durationToleranceSeconds, type AspectFormat } from "@atlas/shared";
import { Button, EmptyState, Notice, PageSpinner, Segmented } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { StatusBadge } from "../components/StatusBadge";
import { keys, useProject, useStoryboard } from "../hooks/queries";
import { api, ApiError } from "../services/api";
import { checkDraft, useEditor, useIsDirty } from "../stores/editor";
import { MapPreview } from "../features/editor/MapPreview";
import { SceneList } from "../features/editor/SceneList";
import { SceneInspector } from "../features/editor/SceneInspector";
import { ValidationPanel } from "../features/editor/ValidationPanel";
import { formatSeconds } from "../lib/format";

function usePlayback(durationSeconds: number, onEnd: () => void) {
  const [t, setT] = useState(0.6);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((cur) => {
        const next = cur + dt / durationSeconds;
        if (next >= 1) {
          queueMicrotask(() => endRef.current());
          return 1;
        }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, durationSeconds]);
  return { t, setT, playing, setPlaying };
}

export function EditorPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const project = useProject(projectId);
  const storyboard = useStoryboard(projectId);
  const store = useEditor();
  const { draft, selectedSceneId, baseVersion } = store;
  const dirty = useIsDirty();
  const [format, setFormat] = useState<AspectFormat>("16:9");
  const [playAll, setPlayAll] = useState(false);

  // Load the server copy into the editor once per project (or when it changes underneath a clean editor).
  useEffect(() => {
    const dto = storyboard.data;
    if (!dto) return;
    const s = useEditor.getState();
    if (s.projectId !== projectId || (!dirty && dto.version !== s.baseVersion)) {
      s.load(projectId, dto);
      setFormat(dto.storyboard.formats.includes("16:9") ? "16:9" : "9:16");
    }
  }, [storyboard.data, projectId, dirty]);

  const ready = !!draft && store.projectId === projectId;
  const check = useMemo(() => (ready && draft ? checkDraft(draft) : null), [ready, draft]);
  const sceneIndex = ready && draft ? Math.max(0, draft.scenes.findIndex((s) => s.id === selectedSceneId)) : 0;
  const scene = ready && draft ? draft.scenes[sceneIndex] : undefined;

  const playback = usePlayback(scene?.durationSeconds ?? 5, () => {
    if (playAll && draft && sceneIndex < draft.scenes.length - 1) {
      store.select(draft.scenes[sceneIndex + 1]!.id);
      playback.setT(0);
    } else {
      playback.setPlaying(false);
    }
  });

  const generate = useMutation({
    mutationFn: () => api.generateStoryboard(projectId),
    onSuccess: (dto) => {
      qc.setQueryData(keys.storyboard(projectId), dto);
      useEditor.getState().load(projectId, dto);
      void qc.invalidateQueries({ queryKey: keys.project(projectId) });
    },
  });

  const save = useMutation({
    mutationFn: () => api.saveStoryboard(projectId, useEditor.getState().draft!, useEditor.getState().baseVersion),
    onSuccess: (dto) => {
      useEditor.getState().markSaved(dto);
      qc.setQueryData(keys.storyboard(projectId), dto);
      void qc.invalidateQueries({ queryKey: keys.project(projectId) });
    },
  });

  const regenerate = useMutation({
    mutationFn: (instructions: string) => api.regenerateScene(projectId, selectedSceneId!, baseVersion, instructions),
    onSuccess: (dto) => {
      useEditor.getState().markSaved(dto);
      qc.setQueryData(keys.storyboard(projectId), dto);
    },
  });

  const reloadLatest = async () => {
    const dto = await qc.fetchQuery({ queryKey: keys.storyboard(projectId), queryFn: () => api.getStoryboard(projectId), staleTime: 0 });
    useEditor.getState().load(projectId, dto);
    save.reset();
  };

  const canSave = dirty && !!check && check.schemaIssues.length === 0 && !save.isPending;
  const onSave = useCallback(() => {
    if (canSave) save.mutate();
  }, [canSave, save]);

  // Keyboard shortcuts: Ctrl/Cmd+S to save, Ctrl/Cmd+Z / Shift+Z to undo/redo (outside text fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      }
      const inField = (e.target as HTMLElement).closest("input, textarea, select");
      if (!inField && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [dirty]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  if (project.isPending || storyboard.isPending) return <PageSpinner />;
  if (project.isError) return <div className="mx-auto max-w-2xl p-8"><ErrorNotice error={project.error} title="Could not open this project" /></div>;
  if (storyboard.isError) return <div className="mx-auto max-w-2xl p-8"><ErrorNotice error={storyboard.error} onRetry={() => void storyboard.refetch()} /></div>;

  if (!storyboard.data) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="mb-6 text-xl font-semibold">{project.data.title}</h1>
        <EmptyState
          icon={<Sparkles className="size-8" />}
          title="No storyboard yet"
          action={
            <Button variant="primary" busy={generate.isPending} onClick={() => generate.mutate()} icon={<Sparkles className="size-4" />}>
              Plan storyboard
            </Button>
          }
        >
          <p className="whitespace-pre-wrap">{project.data.prompt}</p>
        </EmptyState>
        {generate.isError && <div className="mt-4"><ErrorNotice error={generate.error} title="Planning failed" /></div>}
      </div>
    );
  }
  if (!ready || !draft || !check) return <PageSpinner />;

  const total = draft.scenes.reduce((n, s) => n + s.durationSeconds, 0);
  const tolerance = durationToleranceSeconds(draft.durationSeconds);
  const off = Math.abs(total - draft.durationSeconds) > tolerance;
  const conflict = save.error instanceof ApiError && save.error.code === "version_conflict";
  const renderBlocked = !check.ok || dirty;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <input
            aria-label="Video title"
            className="w-full min-w-[12rem] truncate bg-transparent text-[15px] font-medium focus:outline-none"
            maxLength={140}
            value={draft.projectTitle}
            onChange={(e) => store.updateStoryboard({ projectTitle: e.target.value })}
          />
          <p className="text-xs text-faint">
            <span className={clsx(off && "text-warn")}>
              {formatSeconds(total)} of {formatSeconds(draft.durationSeconds)} target
            </span>
            {" · "}
            {draft.language === "hi" ? "Hindi" : "English"} · version {baseVersion}
            {draft.planner && ` · planned by ${draft.planner.provider}${draft.planner.model ? ` (${draft.planner.model})` : ""}`}
          </p>
        </div>
        <StatusBadge status={project.data.status} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={store.past.length === 0} onClick={store.undo} icon={<Undo2 className="size-4" />} />
          <Button size="sm" variant="ghost" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={store.future.length === 0} onClick={store.redo} icon={<Redo2 className="size-4" />} />
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => storyboard.data && store.load(projectId, storyboard.data)}>
              Discard
            </Button>
          )}
          <Button size="sm" busy={save.isPending} disabled={!canSave} onClick={onSave} icon={<Save className="size-4" />} title={check.schemaIssues.length ? "Fix the highlighted fields first" : "Save (Ctrl+S)"}>
            {dirty ? "Save" : "Saved"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={renderBlocked}
            title={dirty ? "Save your changes first" : !check.ok ? "Fix the errors listed below the preview" : undefined}
            onClick={() => navigate(`/projects/${projectId}/render`)}
            icon={<Clapperboard className="size-4" />}
          >
            Render
          </Button>
        </div>
      </div>

      {draft.planner?.deterministic && (
        <div className="border-b border-line px-4 py-2">
          <Notice tone="info" title="Offline plan: places and coordinates come from the Natural Earth gazetteer">
            {draft.planner.notes.length > 0 ? draft.planner.notes.join(" ") : "Narration is placeholder text for you to rewrite."}
          </Notice>
        </div>
      )}
      {save.isError && (
        <div className="border-b border-line px-4 py-2">
          {conflict ? (
            <Notice tone="warn" title="Someone else saved this storyboard" action={<Button size="sm" onClick={() => void reloadLatest()}>Load latest (discards your changes)</Button>}>
              Your changes were not saved because a newer version exists.
            </Notice>
          ) : (
            <ErrorNotice error={save.error} title="Could not save" />
          )}
        </div>
      )}
      {regenerate.isError && <div className="border-b border-line px-4 py-2"><ErrorNotice error={regenerate.error} title="Could not regenerate the scene" /></div>}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_1fr_380px]">
        <aside className="hidden min-h-0 border-r border-line lg:block">
          <SceneList issues={[...check.errors, ...check.warnings]} />
        </aside>

        <section className="flex min-h-0 flex-col">
          <div className="flex items-center gap-3 border-b border-line px-4 py-2">
            {draft.formats.length > 1 && (
              <Segmented label="Preview format" value={format} onChange={setFormat} options={draft.formats.map((f) => ({ value: f, label: f }))} />
            )}
            <Button size="sm" variant="ghost" aria-label={playback.playing ? "Pause" : "Play"} icon={playback.playing ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => {
              if (!playback.playing && playback.t >= 1) playback.setT(0);
              playback.setPlaying(!playback.playing);
            }} />
            <input type="range" aria-label="Scene time" min={0} max={1} step={0.001} value={playback.t} onChange={(e) => (playback.setPlaying(false), playback.setT(Number(e.target.value)))} className="flex-1 accent-[var(--color-accent)]" />
            <span className="w-24 text-right text-xs text-faint tabular-nums">
              {(playback.t * (scene?.durationSeconds ?? 0)).toFixed(1)}s / {scene?.durationSeconds}s
            </span>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={playAll} onChange={(e) => setPlayAll(e.target.checked)} className="accent-[var(--color-accent)]" /> Play through
            </label>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center bg-[#090b0d] p-4">
            <MapPreview scenes={draft.scenes} sceneIndex={sceneIndex} format={format} t={playback.t} />
          </div>
          <p className="border-t border-line px-4 py-1.5 text-[11px] text-faint">Preview is approximate (MapLibre, 50m data). The final video is drawn by the render worker from the same storyboard and camera timeline.</p>
          <div className="border-t border-line">
            <ValidationPanel errors={check.errors} warnings={check.warnings} />
          </div>
        </section>

        <aside className="min-h-0 border-l border-line">
          {/* Small screens get the scene picker above the inspector. */}
          <div className="border-b border-line p-2 lg:hidden">
            <select aria-label="Scene" className="h-9 w-full rounded-md border border-line bg-surface px-2 text-sm" value={selectedSceneId ?? ""} onChange={(e) => store.select(e.target.value)}>
              {draft.scenes.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {i + 1}. {s.title || s.location.name}
                </option>
              ))}
            </select>
          </div>
          {scene && <SceneInspector key={scene.id} scene={scene} onRegenerate={(i) => regenerate.mutate(i)} regenerating={regenerate.isPending} canRegenerate={!dirty} />}
        </aside>
      </div>

      {blocker.state === "blocked" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="leave-title">
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-5">
            <h2 id="leave-title" className="font-medium">Leave without saving?</h2>
            <p className="mt-1 text-sm text-muted">Your storyboard changes will be lost.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => blocker.reset()}>Stay</Button>
              <Button variant="danger" onClick={() => blocker.proceed()}>
                Leave
              </Button>
            </div>
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">{save.isSuccess && !dirty ? "Saved" : ""}</span>
      <Link to="/dashboard" className="sr-only">Back to projects</Link>
    </div>
  );
}
