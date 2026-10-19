import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Film, Globe2, MoreHorizontal, Search, Trash2 } from "lucide-react";
import type { ProjectDto } from "@atlas/shared";
import { Button, EmptyState, Input, Notice, PageSpinner, Select } from "../components/ui";
import { StatusBadge } from "../components/StatusBadge";
import { ErrorNotice } from "../components/ErrorNotice";
import { useHealth, useProjects } from "../hooks/queries";
import { api, inlineAssetUrl } from "../services/api";
import { timeAgo } from "../lib/format";

type Sort = "updatedAt" | "createdAt" | "title";

function nextStepLink(p: ProjectDto): { to: string; label: string } {
  if (p.status === "rendering" && p.latestRenderId) return { to: `/projects/${p.id}/render/${p.latestRenderId}`, label: "View render" };
  if (p.status === "rendered") return { to: `/projects/${p.id}/export`, label: "Downloads" };
  if (p.hasStoryboard) return { to: `/projects/${p.id}/storyboard`, label: "Open storyboard" };
  return { to: `/projects/${p.id}/storyboard`, label: "Plan storyboard" };
}

function ProjectCard({ project }: { project: ProjectDto }) {
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const del = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
  const step = nextStepLink(project);
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-lg border border-line bg-surface transition-colors hover:border-line-strong">
      <Link to={step.to} className="block aspect-video bg-surface-2">
        {project.thumbnailAssetId ? (
          <img src={inlineAssetUrl(project.thumbnailAssetId)} alt="" className="size-full object-cover" loading="lazy" />
        ) : (
          <div className="flex size-full items-center justify-center text-faint">
            <Globe2 className="size-8" />
          </div>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-start gap-2">
          <Link to={step.to} className="min-w-0 flex-1">
            <h3 className="truncate font-medium" title={project.title}>
              {project.title}
            </h3>
          </Link>
          <div className="relative">
            <button
              type="button"
              aria-label="Project actions"
              className="rounded p-1 text-faint hover:bg-surface-2 hover:text-fg"
              onClick={() => setMenu((m) => !m)}
              onBlur={() => setTimeout(() => setMenu(false), 150)}
            >
              <MoreHorizontal className="size-4" />
            </button>
            {menu && (
              <div className="absolute right-0 z-10 mt-1 w-44 rounded-md border border-line bg-surface-2 p-1 shadow-xl">
                <Link to={`/projects/${project.id}/storyboard`} className="block rounded px-2.5 py-1.5 text-sm hover:bg-surface-3">
                  Storyboard
                </Link>
                <Link to={`/projects/${project.id}/export`} className="block rounded px-2.5 py-1.5 text-sm hover:bg-surface-3">
                  Render &amp; export
                </Link>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-danger hover:bg-danger/10"
                  onClick={() => {
                    if (confirm(`Delete "${project.title}"? Its storyboard and videos will no longer be listed.`)) del.mutate();
                  }}
                >
                  <Trash2 className="size-3.5" /> Delete
                </button>
              </div>
            )}
          </div>
        </div>
        <p className="line-clamp-2 text-[13px] text-muted">{project.prompt}</p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-xs text-faint">
          <StatusBadge status={project.status} />
          <span>
            {project.options.language === "hi" ? "Hindi" : "English"} · {project.options.durationSeconds}s · {timeAgo(project.updatedAt)}
          </span>
        </div>
        {del.isError && <p className="text-xs text-danger">Could not delete this project.</p>}
      </div>
    </article>
  );
}

export function DashboardPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const sort = (params.get("sort") as Sort | null) ?? "updatedAt";
  const page = Number(params.get("page") ?? 1) || 1;
  const [search, setSearch] = useState(q);
  const projects = useProjects({ q: q || undefined, sort, order: sort === "title" ? "asc" : "desc", page, pageSize: 12 });
  const health = useHealth();

  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== q) setParams((p) => (search ? p.set("q", search) : p.delete("q"), p.delete("page"), p), { replace: true });
    }, 300);
    return () => clearTimeout(t);
  }, [search, q, setParams]);

  const degraded = health.data && health.data.status !== "ok" ? Object.entries(health.data.checks).filter(([, c]) => !c.ok) : [];
  const totalPages = projects.data ? Math.max(1, Math.ceil(projects.data.total / projects.data.pageSize)) : 1;

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="mt-1 text-sm text-muted">Each project holds one storyboard and its renders.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
            <Input aria-label="Search projects" placeholder="Search" className="w-56 pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select aria-label="Sort" className="w-40" value={sort} onChange={(e) => setParams((p) => (p.set("sort", e.target.value), p.delete("page"), p))}>
            <option value="updatedAt">Recently edited</option>
            <option value="createdAt">Newest</option>
            <option value="title">Title A–Z</option>
          </Select>
        </div>
      </div>

      {degraded.length > 0 && (
        <div className="mb-6">
          <Notice tone="warn" title="Some server components are not ready">
            {degraded.map(([k, c]) => `${k}${c.detail ? ` (${c.detail})` : ""}`).join(", ")}. Planning or rendering may fail until this is fixed.
          </Notice>
        </div>
      )}

      {projects.isPending ? (
        <PageSpinner />
      ) : projects.isError ? (
        <ErrorNotice error={projects.error} title="Could not load projects" onRetry={() => void projects.refetch()} />
      ) : projects.data.items.length === 0 ? (
        q ? (
          <EmptyState icon={<Search className="size-8" />} title={`No projects match "${q}"`} action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
        ) : (
          <EmptyState
            icon={<Clapperboard className="size-8" />}
            title="No projects yet"
            action={
              <Link to="/projects/new">
                <Button variant="primary" icon={<Film className="size-4" />}>
                  Create your first map video
                </Button>
              </Link>
            }
          >
            Describe a geography story, such as the rivers of Nepal flowing into India, and AtlasMotion will plan it scene by scene.
          </EmptyState>
        )
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projects.data.items.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="mt-8 flex items-center justify-center gap-3 text-sm">
              <Button size="sm" disabled={page <= 1} onClick={() => setParams((p) => (p.set("page", String(page - 1)), p))}>
                Previous
              </Button>
              <span className="text-muted">
                Page {page} of {totalPages}
              </span>
              <Button size="sm" disabled={page >= totalPages} onClick={() => setParams((p) => (p.set("page", String(page + 1)), p))}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
