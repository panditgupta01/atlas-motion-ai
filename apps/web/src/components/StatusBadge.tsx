import clsx from "clsx";
import type { ProjectStatus, RenderJobStatus, SceneRenderStatus } from "@atlas/shared";

const LABELS: Record<string, string> = {
  draft: "Draft",
  planning: "Planning",
  awaiting_review: "Needs review",
  rendering: "Rendering",
  rendered: "Rendered",
  render_failed: "Render failed",
  queued: "Queued",
  rendering_scenes: "Rendering scenes",
  generating_audio: "Generating audio",
  assembling: "Assembling",
  validating: "Validating",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  retrying: "Retrying",
  pending: "Pending",
  done: "Done",
  cached: "Reused",
  skipped: "Skipped",
};

function tone(status: string) {
  if (["rendered", "completed", "done", "cached"].includes(status)) return "ok";
  if (["render_failed", "failed"].includes(status)) return "danger";
  if (["awaiting_review", "retrying"].includes(status)) return "warn";
  if (["draft", "cancelled", "pending", "skipped"].includes(status)) return "muted";
  return "info";
}

export function StatusBadge({ status, className }: { status: ProjectStatus | RenderJobStatus | SceneRenderStatus; className?: string }) {
  const t = tone(status);
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        t === "ok" && "border-ok/30 bg-ok/10 text-ok",
        t === "danger" && "border-danger/30 bg-danger/10 text-danger",
        t === "warn" && "border-warn/30 bg-warn/10 text-warn",
        t === "info" && "border-info/30 bg-info/10 text-info",
        t === "muted" && "border-line bg-surface-2 text-muted",
        className,
      )}
    >
      {t === "info" && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {LABELS[status] ?? status}
    </span>
  );
}
