import { AlertCircle, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { StoryboardIssue } from "@atlas/shared";
import { useEditor } from "../../stores/editor";

export function ValidationPanel({ errors, warnings }: { errors: StoryboardIssue[]; warnings: StoryboardIssue[] }) {
  const select = useEditor((s) => s.select);
  const scenes = useEditor((s) => s.draft?.scenes ?? []);
  const sceneNo = (id?: string) => (id ? scenes.findIndex((s) => s.id === id) + 1 : 0);

  if (errors.length === 0 && warnings.length === 0) {
    return (
      <p className="flex items-center gap-2 px-3 py-2.5 text-sm text-ok">
        <CheckCircle2 className="size-4" /> No problems found. The storyboard is ready to render.
      </p>
    );
  }
  const row = (issue: StoryboardIssue, i: number) => {
    const n = sceneNo(issue.sceneId);
    return (
      <li key={`${issue.code}-${i}`}>
        <button
          type="button"
          disabled={!issue.sceneId}
          onClick={() => issue.sceneId && select(issue.sceneId)}
          className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 disabled:hover:bg-transparent"
        >
          {issue.severity === "error" ? <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-danger" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />}
          <span className="min-w-0">
            {n > 0 && <span className="mr-1.5 text-faint">Scene {n}</span>}
            <span className="text-fg/90">{issue.message}</span>
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className="p-1.5">
      <p className="px-2 pt-1 pb-1.5 text-xs text-muted">
        {errors.length > 0 ? `${errors.length} error${errors.length > 1 ? "s" : ""} must be fixed before rendering` : "Ready to render"}
        {warnings.length > 0 && ` · ${warnings.length} warning${warnings.length > 1 ? "s" : ""}`}
      </p>
      <ul className="max-h-48 overflow-y-auto">
        {errors.map(row)}
        {warnings.map(row)}
      </ul>
    </div>
  );
}
