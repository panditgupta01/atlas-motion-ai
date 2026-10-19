import { useState } from "react";
import clsx from "clsx";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { CAMERA_MOVES, MAX_SCENE_SECONDS, MIN_SCENE_SECONDS, estimateNarrationSeconds, type Scene } from "@atlas/shared";
import { useEditor } from "../../stores/editor";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";
import { GazetteerSearch } from "./GazetteerSearch";
import { OverlayEditor } from "./OverlayEditor";
import { ClaimsEditor, SourcesEditor } from "./FactsEditor";

const MOVE_LABELS: Record<(typeof CAMERA_MOVES)[number], string> = {
  static: "Static",
  zoom_to: "Zoom in",
  zoom_out: "Zoom out",
  pan_to: "Pan",
  orbit: "Orbit",
  follow_route: "Follow route",
};

const SOURCE_LABELS = { gazetteer: "Natural Earth gazetteer", user: "entered by you", planner: "suggested by the planner, unverified" };

type Tab = "scene" | "overlays" | "facts" | "sources";

export function SceneInspector({ scene, onRegenerate, regenerating, canRegenerate }: { scene: Scene; onRegenerate: (instructions: string) => void; regenerating: boolean; canRegenerate: boolean }) {
  const [tab, setTab] = useState<Tab>("scene");
  const [instructions, setInstructions] = useState("");
  const updateScene = useEditor((s) => s.updateScene);
  const language = useEditor((s) => s.draft?.language ?? "en");
  const up = (patch: Partial<Scene>) => updateScene(scene.id, patch);
  const est = estimateNarrationSeconds(scene.narration, language);
  const unsupported = scene.claims.filter((c) => c.status === "unsupported").length;

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "scene", label: "Scene" },
    { id: "overlays", label: "Overlays", badge: scene.overlays.length },
    { id: "facts", label: "Claims", badge: unsupported || undefined },
    { id: "sources", label: "Sources" },
  ];

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" className="flex border-b border-line px-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={clsx("relative px-3 py-2.5 text-[13px]", tab === t.id ? "text-fg" : "text-muted hover:text-fg")}
          >
            {t.label}
            {t.badge !== undefined && <span className={clsx("ml-1.5 rounded px-1 text-[10px]", t.id === "facts" ? "bg-danger/20 text-danger" : "bg-surface-3 text-muted")}>{t.badge}</span>}
            {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded bg-accent" />}
          </button>
        ))}
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {tab === "scene" && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-faint">
                Revision {scene.revision} · {scene.status}
              </span>
              <Button size="sm" variant={scene.status === "approved" ? "secondary" : "ghost"} icon={<CheckCircle2 className={clsx("size-3.5", scene.status === "approved" && "text-ok")} />} onClick={() => up({ status: scene.status === "approved" ? "edited" : "approved" })}>
                {scene.status === "approved" ? "Approved" : "Approve scene"}
              </Button>
            </div>
            <Field label="Scene title" htmlFor="scene-title">
              <Input id="scene-title" maxLength={120} value={scene.title ?? ""} onChange={(e) => up({ title: e.target.value || undefined })} />
            </Field>
            <Field label={`Duration: ${scene.durationSeconds}s`} htmlFor="scene-duration">
              <input id="scene-duration" type="range" min={MIN_SCENE_SECONDS} max={MAX_SCENE_SECONDS} step={0.5} value={scene.durationSeconds} onChange={(e) => up({ durationSeconds: Number(e.target.value) })} className="w-full accent-[var(--color-accent)]" />
            </Field>

            <div className="space-y-2">
              <p className="text-[13px] font-medium text-muted">Location</p>
              <GazetteerSearch
                onPick={(h) =>
                  up({ location: { name: h.name, latitude: h.latitude, longitude: h.longitude, source: "gazetteer", gazetteerId: h.id } })
                }
              />
              <div className="grid grid-cols-[1fr_7rem_7rem] gap-2">
                <Input aria-label="Location name" maxLength={120} value={scene.location.name} onChange={(e) => up({ location: { ...scene.location, name: e.target.value } })} />
                <Input aria-label="Latitude" type="number" step="0.0001" min={-90} max={90} value={scene.location.latitude} onChange={(e) => up({ location: { ...scene.location, latitude: Number(e.target.value) || 0, source: "user", gazetteerId: undefined } })} />
                <Input aria-label="Longitude" type="number" step="0.0001" min={-180} max={180} value={scene.location.longitude} onChange={(e) => up({ location: { ...scene.location, longitude: Number(e.target.value) || 0, source: "user", gazetteerId: undefined } })} />
              </div>
              <p className={clsx("text-[11px]", scene.location.source === "planner" ? "text-warn" : "text-faint")}>Coordinates {SOURCE_LABELS[scene.location.source]}.</p>
            </div>

            <div className="space-y-2">
              <p className="text-[13px] font-medium text-muted">Camera</p>
              <div className="grid grid-cols-2 gap-2">
                <Select aria-label="Camera move" value={scene.camera.move} onChange={(e) => up({ camera: { ...scene.camera, move: e.target.value as Scene["camera"]["move"] } })}>
                  {CAMERA_MOVES.map((m) => (
                    <option key={m} value={m}>
                      {MOVE_LABELS[m]}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Easing" value={scene.camera.easing} onChange={(e) => up({ camera: { ...scene.camera, easing: e.target.value as "linear" | "ease_in_out" } })}>
                  <option value="ease_in_out">Ease in and out</option>
                  <option value="linear">Linear</option>
                </Select>
                <Field label={`Start zoom ${scene.camera.zoomStart.toFixed(1)}`}>
                  <input type="range" min={0} max={12} step={0.1} value={scene.camera.zoomStart} onChange={(e) => up({ camera: { ...scene.camera, zoomStart: Number(e.target.value) } })} className="w-full accent-[var(--color-accent)]" />
                </Field>
                <Field label={`End zoom ${scene.camera.zoomEnd.toFixed(1)}`}>
                  <input type="range" min={0} max={12} step={0.1} value={scene.camera.zoomEnd} onChange={(e) => up({ camera: { ...scene.camera, zoomEnd: Number(e.target.value) } })} className="w-full accent-[var(--color-accent)]" />
                </Field>
              </div>
              <p className="text-[11px] text-faint">0 shows the whole globe, about 4 a country, 7 a region, 10 a city.</p>
            </div>

            <Field label="Narration" htmlFor="narration" hint={scene.narration ? `About ${est.toFixed(1)}s to speak${est > scene.durationSeconds ? ", longer than the scene" : ""}.` : "Leave empty for a silent scene."}>
              <Textarea id="narration" rows={5} maxLength={1200} lang={language} value={scene.narration} onChange={(e) => up({ narration: e.target.value })} />
            </Field>

            <div className="space-y-2 rounded-md border border-line p-3">
              <p className="text-[13px] font-medium text-muted">Regenerate this scene</p>
              <Input placeholder="Optional instructions, e.g. focus on the delta" maxLength={1000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
              <Button size="sm" icon={<RefreshCw className="size-3.5" />} busy={regenerating} disabled={!canRegenerate} onClick={() => onRegenerate(instructions)}>
                Regenerate
              </Button>
              {!canRegenerate && <p className="text-[11px] text-faint">Save or discard your changes first.</p>}
            </div>
          </>
        )}
        {tab === "overlays" && <OverlayEditor scene={scene} />}
        {tab === "facts" && <ClaimsEditor scene={scene} />}
        {tab === "sources" && <SourcesEditor />}
      </div>
    </div>
  );
}
