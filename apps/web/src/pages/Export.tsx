import { Link, useParams } from "react-router";
import { ArrowLeft, Clapperboard } from "lucide-react";
import type { RenderJobDto } from "@atlas/shared";
import { Button, Card, EmptyState, PageSpinner } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { StatusBadge } from "../components/StatusBadge";
import { useProject, useRenders } from "../hooks/queries";
import { groupOutputs, VideoOutput } from "../features/render/OutputCard";
import { formatDateTime } from "../lib/format";

function duration(r: RenderJobDto): string {
  if (!r.startedAt || !r.finishedAt) return "";
  const s = (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000;
  return s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`;
}

export function ExportPage() {
  const { projectId = "" } = useParams();
  const project = useProject(projectId);
  const renders = useRenders(projectId);

  if (project.isPending || renders.isPending) return <PageSpinner />;
  if (project.isError || renders.isError) return <div className="mx-auto max-w-2xl p-8"><ErrorNotice error={project.error ?? renders.error} /></div>;
  const latest = renders.data.find((r) => r.status === "completed");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link to={`/projects/${projectId}/storyboard`} className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" /> Storyboard
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{project.data.title}</h1>
          <p className="mt-1 text-sm text-muted">Downloads. Only renders that passed validation (codec, resolution, duration, full decode) are listed as outputs.</p>
        </div>
        <Link to={`/projects/${projectId}/render`}>
          <Button variant="primary" icon={<Clapperboard className="size-4" />}>New render</Button>
        </Link>
      </div>

      {latest ? (
        <section className="mb-10">
          <h2 className="mb-3 text-sm font-medium text-muted">Latest completed render · {formatDateTime(latest.finishedAt ?? latest.createdAt)} · storyboard v{latest.storyboardVersion}</h2>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            {groupOutputs(latest.outputs)
              .sort((a) => (a.video.format === "9:16" ? -1 : 1))
              .map((o) => <VideoOutput key={o.video.id} asset={o.video} subtitle={o.subtitle} />)}
          </div>
        </section>
      ) : (
        <div className="mb-10">
          <EmptyState icon={<Clapperboard className="size-8" />} title="No finished video yet" action={<Link to={`/projects/${projectId}/render`}><Button variant="primary">Set up a render</Button></Link>}>
            Once a render completes and passes validation, its MP4 and subtitle files appear here.
          </EmptyState>
        </div>
      )}

      <h2 className="mb-3 font-medium">Render history</h2>
      {renders.data.length === 0 ? (
        <p className="text-sm text-faint">No renders yet.</p>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-faint">
                <th className="px-4 py-2 font-normal">Started</th>
                <th className="px-4 py-2 font-normal">Status</th>
                <th className="px-4 py-2 font-normal">Settings</th>
                <th className="px-4 py-2 font-normal">Took</th>
                <th className="px-4 py-2 font-normal">Files</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {renders.data.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-4 py-2.5 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-2.5 text-muted">
                    {r.settings.formats.join(" + ")} · {r.settings.quality} · {r.settings.fps} fps · v{r.storyboardVersion}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{duration(r)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-2">
                      {r.outputs.map((a) => (
                        <a key={a.id} href={a.downloadUrl} download className="text-xs text-accent hover:underline">
                          {a.kind === "video" ? `${a.format} MP4` : `${a.format ?? ""} ${a.kind === "subtitle" ? "SRT" : a.kind}`}
                        </a>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link to={`/projects/${projectId}/render/${r.id}`} className="text-xs text-muted hover:text-fg">Details</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
