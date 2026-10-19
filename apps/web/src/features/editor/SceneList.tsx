import clsx from "clsx";
import { ArrowDown, ArrowUp, CheckCircle2, Copy, Plus, Trash2 } from "lucide-react";
import { MAX_SCENES, type StoryboardIssue } from "@atlas/shared";
import { useEditor } from "../../stores/editor";
import { Button } from "../../components/ui";
import { formatSeconds } from "../../lib/format";

export function SceneList({ issues }: { issues: StoryboardIssue[] }) {
  const draft = useEditor((s) => s.draft)!;
  const selected = useEditor((s) => s.selectedSceneId);
  const { select, moveScene, duplicateScene, deleteScene, addScene } = useEditor.getState();
  let elapsed = 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <h2 className="text-[13px] font-medium text-muted">
          Scenes <span className="text-faint">({draft.scenes.length})</span>
        </h2>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} disabled={draft.scenes.length >= MAX_SCENES} onClick={() => addScene(selected ?? undefined)}>
          Add
        </Button>
      </div>
      <ol className="flex-1 space-y-1 overflow-y-auto p-2">
        {draft.scenes.map((scene, i) => {
          const start = elapsed;
          elapsed += scene.durationSeconds;
          const errs = issues.filter((x) => x.sceneId === scene.id && x.severity === "error").length;
          const warns = issues.filter((x) => x.sceneId === scene.id && x.severity === "warning").length;
          const active = scene.id === selected;
          return (
            <li key={scene.id}>
              <div
                role="button"
                tabIndex={0}
                aria-current={active}
                onClick={() => select(scene.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), select(scene.id))}
                className={clsx(
                  "group rounded-md border px-2.5 py-2 text-left transition-colors",
                  active ? "border-accent/50 bg-accent/5" : "border-transparent hover:bg-surface-2",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-xs text-faint tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{scene.title || scene.location.name}</span>
                  {scene.status === "approved" && <CheckCircle2 className="size-3.5 shrink-0 text-ok" aria-label="Approved" />}
                </div>
                <div className="mt-1 flex items-center gap-2 pl-7 text-[11px] text-faint">
                  <span className="tabular-nums">
                    {formatSeconds(start)}–{formatSeconds(elapsed)}
                  </span>
                  <span className="truncate">{scene.camera.move.replace("_", " ")}</span>
                  {errs > 0 && <span className="ml-auto rounded bg-danger/15 px-1.5 text-danger">{errs} error{errs > 1 ? "s" : ""}</span>}
                  {errs === 0 && warns > 0 && <span className="ml-auto rounded bg-warn/15 px-1.5 text-warn">{warns}</span>}
                </div>
                {active && (
                  <div className="mt-2 flex items-center gap-0.5 pl-6">
                    <IconBtn label="Move up" disabled={i === 0} onClick={() => moveScene(scene.id, -1)} icon={<ArrowUp className="size-3.5" />} />
                    <IconBtn label="Move down" disabled={i === draft.scenes.length - 1} onClick={() => moveScene(scene.id, 1)} icon={<ArrowDown className="size-3.5" />} />
                    <IconBtn label="Duplicate" disabled={draft.scenes.length >= MAX_SCENES} onClick={() => duplicateScene(scene.id)} icon={<Copy className="size-3.5" />} />
                    <IconBtn label="Delete" disabled={draft.scenes.length <= 1} onClick={() => deleteScene(scene.id)} icon={<Trash2 className="size-3.5" />} danger />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function IconBtn({ label, icon, onClick, disabled, danger }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={clsx("rounded p-1.5 text-faint hover:bg-surface-3 disabled:opacity-30", danger ? "hover:text-danger" : "hover:text-fg")}
    >
      {icon}
    </button>
  );
}
