import { useMemo, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, RotateCcw, Square } from "lucide-react";
import { isTerminal, type CreateRenderRequest, type RenderJobDto } from "@atlas/shared";
import { Button, Card, Notice, PageSpinner, Progress } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { StatusBadge } from "../components/StatusBadge";
import { keys, useProject, useProviders, useRender, useRenders, useStoryboard } from "../hooks/queries";
import { api, ApiError } from "../services/api";
import { RenderSettingsForm } from "../features/render/RenderSettingsForm";
import { groupOutputs, VideoOutput } from "../features/render/OutputCard";
import { formatDateTime, randomKey } from "../lib/format";

const STAGES = ["queued", "rendering_scenes", "generating_audio", "assembling", "validating", "completed"] as const;
const STAGE_LABELS = { queued: "Queued", rendering_scenes: "Scenes", generating_audio: "Audio", assembling: "Assemble", validating: "Validate", completed: "Done" };

function StageTrack({ render }: { render: RenderJobDto }) {
  const idx = STAGES.indexOf(render.status as (typeof STAGES)[number]);
  return (
    <ol className="flex items-center gap-1">
      {STAGES.map((s, i) => {
        const done = render.status === "completed" || (idx >= 0 && i < idx);
        const current = i === idx && render.status !== "completed";
        return (
          <li key={s} className="flex flex-1 flex-col gap-1.5">
            <span className={clsx("h-1 rounded-full", done ? "bg-ok" : current ? "animate-pulse bg-accent" : "bg-surface-3")} />
            <span className={clsx("text-[11px]", current ? "text-fg" : "text-faint")}>{STAGE_LABELS[s]}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RenderProgress({ renderId, projectId }: { renderId: string; projectId: string }) {
  const render = useRender(renderId);
  const storyboard = useStoryboard(projectId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cancel = useMutation({ mutationFn: () => api.cancelRender(renderId), onSuccess: (d) => qc.setQueryData(keys.render(renderId), d.render) });
  const retry = useMutation({ mutationFn: () => api.retryRender(renderId), onSuccess: (d) => qc.setQueryData(keys.render(renderId), d.render) });
  const titles = useMemo(() => new Map((storyboard.data?.storyboard.scenes ?? []).map((s, i) => [s.id, `${i + 1}. ${s.title || s.location.name}`])), [storyboard.data]);

  if (render.isPending) return <PageSpinner />;
  if (render.isError) return <ErrorNotice error={render.error} title="Could not load this render" />;
  const r = render.data;
  const terminal = isTerminal(r.status);
  const formats = r.settings.formats;
  const sceneIds = [...new Set(r.scenes.map((s) => s.sceneId))];
  const outputs = groupOutputs(r.outputs);

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={r.status} />
          <p className="text-sm text-muted">{r.stage}</p>
          <div className="ml-auto flex gap-2">
            {!terminal && (
              <Button size="sm" variant="danger" busy={cancel.isPending} disabled={r.cancelRequested} onClick={() => cancel.mutate()} icon={<Square className="size-3.5" />}>
                {r.cancelRequested ? "Cancelling…" : "Cancel"}
              </Button>
            )}
            {(r.status === "failed" || r.status === "cancelled") && (
              <Button size="sm" busy={retry.isPending} onClick={() => retry.mutate()} icon={<RotateCcw className="size-3.5" />}>
                Retry (reuses finished scenes)
              </Button>
            )}
          </div>
        </div>
        <StageTrack render={r} />
        <div className="space-y-1.5">
          <Progress value={r.progress.fraction} tone={r.status === "failed" ? "danger" : r.status === "completed" ? "ok" : "accent"} />
          <p className="text-xs text-faint tabular-nums">
            {Math.round(r.progress.fraction * 100)}% · {r.progress.completedUnits.toLocaleString()} of {r.progress.totalUnits.toLocaleString()} frames · {r.settings.quality}, {r.settings.fps} fps
            {r.attempts > 0 && ` · attempt ${r.attempts + 1}`}
          </p>
        </div>
        {r.error && (
          <Notice tone="danger" title={r.status === "cancelled" ? "Render cancelled" : "Render failed"}>
            {r.error.message}
            {r.error.sceneId && ` (scene ${titles.get(r.error.sceneId) ?? r.error.sceneId})`}
          </Notice>
        )}
        {(cancel.isError || retry.isError) && <ErrorNotice error={cancel.error ?? retry.error} />}
        {r.warnings.length > 0 && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer text-warn">{r.warnings.length} storyboard warning{r.warnings.length > 1 ? "s" : ""}</summary>
            <ul className="mt-1 list-disc pl-5">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </details>
        )}
      </Card>

      {r.status === "completed" && outputs.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">Validated outputs</h2>
            <Button size="sm" variant="ghost" onClick={() => navigate(`/projects/${projectId}/export`)}>All downloads</Button>
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            {outputs.sort((a) => (a.video.format === "9:16" ? -1 : 1)).map((o) => <VideoOutput key={o.video.id} asset={o.video} subtitle={o.subtitle} />)}
          </div>
        </section>
      )}

      <section className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <h2 className="border-b border-line px-4 py-2.5 text-[13px] font-medium text-muted">Scenes</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-faint">
                <th className="px-4 py-2 font-normal">Scene</th>
                {formats.map((f) => <th key={f} className="px-2 py-2 font-normal">{f}</th>)}
              </tr>
            </thead>
            <tbody>
              {sceneIds.map((id) => (
                <tr key={id} className="border-t border-line">
                  <td className="max-w-[14rem] truncate px-4 py-2">{titles.get(id) ?? id}</td>
                  {formats.map((f) => {
                    const s = r.scenes.find((x) => x.sceneId === id && x.format === f);
                    if (!s) return <td key={f} />;
                    return (
                      <td key={f} className="px-2 py-2" title={s.error}>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={s.status} />
                          {s.status === "rendering" && <span className="text-[11px] text-faint tabular-nums">{Math.round((s.framesDone / Math.max(1, s.framesTotal)) * 100)}%</span>}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="flex max-h-[28rem] flex-col overflow-hidden">
          <h2 className="border-b border-line px-4 py-2.5 text-[13px] font-medium text-muted">Log</h2>
          <ol className="flex-1 space-y-1 overflow-y-auto p-3 font-mono text-[11.5px]" aria-live="polite">
            {r.logs.map((l, i) => (
              <li key={i} className={clsx(l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warn" : "text-muted")}>
                <span className="text-faint">{new Date(l.at).toLocaleTimeString()}</span> {l.message}
              </li>
            ))}
          </ol>
        </Card>
      </section>
    </div>
  );
}

export function RenderStudioPage() {
  const { projectId = "", renderId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const project = useProject(projectId);
  const storyboard = useStoryboard(projectId, !renderId);
  const providers = useProviders();
  const renders = useRenders(projectId);
  const keyRef = useRef(randomKey());
  const create = useMutation({
    mutationFn: (req: CreateRenderRequest) => api.createRender(projectId, { ...req, idempotencyKey: keyRef.current }),
    onSuccess: ({ render }) => {
      keyRef.current = randomKey();
      qc.setQueryData(keys.render(render.id), render);
      void qc.invalidateQueries({ queryKey: keys.renders(projectId) });
      navigate(`/projects/${projectId}/render/${render.id}`);
    },
  });

  if (project.isPending) return <PageSpinner />;
  if (project.isError) return <div className="mx-auto max-w-2xl p-8"><ErrorNotice error={project.error} /></div>;
  const active = renders.data?.find((r) => !isTerminal(r.status));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link to={`/projects/${projectId}/storyboard`} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Storyboard
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{project.data.title}</h1>
          <p className="mt-1 text-sm text-muted">{renderId ? "Render progress" : "Render settings"}</p>
        </div>
        <Link to={`/projects/${projectId}/export`} className="text-sm text-accent hover:underline">Downloads and history</Link>
      </div>

      {renderId ? (
        <RenderProgress renderId={renderId} projectId={projectId} />
      ) : storyboard.isPending ? (
        <PageSpinner />
      ) : !storyboard.data ? (
        <Notice tone="warn" title="No storyboard yet" action={<Link to={`/projects/${projectId}/storyboard`}><Button size="sm">Open editor</Button></Link>}>Plan and review a storyboard before rendering.</Notice>
      ) : (
        <div className="space-y-4">
          {active && (
            <Notice tone="info" title="A render is already running" action={<Link to={`/projects/${projectId}/render/${active.id}`}><Button size="sm">View progress</Button></Link>}>
              Started {formatDateTime(active.createdAt)}.
            </Notice>
          )}
          {!storyboard.data.validation.ok && (
            <Notice tone="danger" title="The storyboard has errors" action={<Link to={`/projects/${projectId}/storyboard`}><Button size="sm">Fix in editor</Button></Link>}>
              {storyboard.data.validation.errors.slice(0, 3).map((e) => e.message).join(" ")}
            </Notice>
          )}
          <RenderSettingsForm
            storyboard={storyboard.data.storyboard}
            version={storyboard.data.version}
            providers={providers.data ?? []}
            busy={create.isPending}
            onSubmit={(req) => create.mutate(req)}
          />
          {create.isError && (
            <ErrorNotice
              error={create.error}
              title={create.error instanceof ApiError && create.error.code === "version_conflict" ? "The storyboard changed. Reload this page to render the latest version." : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}
