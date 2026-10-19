import { create } from "zustand";
import {
  MAX_SCENES,
  storyboardSchema,
  validateStoryboard,
  type Scene,
  type SourceRef,
  type Storyboard,
  type StoryboardDto,
  type StoryboardIssue,
  type StoryboardValidationResult,
} from "@atlas/shared";

const HISTORY_LIMIT = 50;

interface EditorState {
  projectId: string | null;
  baseVersion: number;
  draft: Storyboard | null;
  saved: string | null;
  selectedSceneId: string | null;
  past: Storyboard[];
  future: Storyboard[];

  load: (projectId: string, dto: StoryboardDto) => void;
  markSaved: (dto: StoryboardDto) => void;
  select: (sceneId: string) => void;
  updateStoryboard: (patch: Partial<Storyboard>) => void;
  updateScene: (sceneId: string, patch: Partial<Scene> | ((s: Scene) => Scene)) => void;
  addScene: (afterId?: string) => void;
  duplicateScene: (sceneId: string) => void;
  deleteScene: (sceneId: string) => void;
  moveScene: (sceneId: string, delta: -1 | 1) => void;
  upsertSource: (source: SourceRef) => void;
  removeSource: (id: string) => void;
  undo: () => void;
  redo: () => void;
}

function uniqueId(prefix: string, taken: Set<string>): string {
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
    if (!taken.has(id)) return id;
  }
}

/** Content edits clear a scene's approval. The server assigns revisions on save. */
function touch(scene: Scene): Scene {
  return { ...scene, status: "edited" };
}

export const useEditor = create<EditorState>((set, get) => {
  /** Apply a change to the draft and record it for undo. */
  const commit = (fn: (sb: Storyboard) => Storyboard) => {
    const { draft, past } = get();
    if (!draft) return;
    const next = fn(draft);
    if (next === draft) return;
    set({ draft: next, past: [...past, draft].slice(-HISTORY_LIMIT), future: [] });
  };

  return {
    projectId: null,
    baseVersion: 0,
    draft: null,
    saved: null,
    selectedSceneId: null,
    past: [],
    future: [],

    load: (projectId, dto) =>
      set({
        projectId,
        baseVersion: dto.version,
        draft: dto.storyboard,
        saved: JSON.stringify(dto.storyboard),
        selectedSceneId: dto.storyboard.scenes[0]?.id ?? null,
        past: [],
        future: [],
      }),

    markSaved: (dto) =>
      set((s) => ({
        baseVersion: dto.version,
        draft: dto.storyboard,
        saved: JSON.stringify(dto.storyboard),
        selectedSceneId: dto.storyboard.scenes.some((x) => x.id === s.selectedSceneId) ? s.selectedSceneId : (dto.storyboard.scenes[0]?.id ?? null),
      })),

    select: (sceneId) => set({ selectedSceneId: sceneId }),

    updateStoryboard: (patch) => commit((sb) => ({ ...sb, ...patch })),

    updateScene: (sceneId, patch) =>
      commit((sb) => ({
        ...sb,
        scenes: sb.scenes.map((s) => {
          if (s.id !== sceneId) return s;
          const next = typeof patch === "function" ? patch(s) : { ...s, ...patch };
          // Changing only the review status is not a content edit.
          const statusOnly = typeof patch !== "function" && Object.keys(patch).every((k) => k === "status");
          return statusOnly ? next : touch(next);
        }),
      })),

    addScene: (afterId) =>
      commit((sb) => {
        if (sb.scenes.length >= MAX_SCENES) return sb;
        const idx = afterId ? sb.scenes.findIndex((s) => s.id === afterId) : sb.scenes.length - 1;
        const ref = sb.scenes[idx] ?? sb.scenes[sb.scenes.length - 1]!;
        const id = uniqueId("scene", new Set(sb.scenes.map((s) => s.id)));
        const scene: Scene = {
          id,
          title: "New scene",
          durationSeconds: 5,
          location: { ...ref.location },
          camera: { move: "static", zoomStart: ref.camera.zoomEnd, zoomEnd: ref.camera.zoomEnd, easing: "ease_in_out" },
          narration: "",
          overlays: [],
          claims: [],
          sourceRefs: [],
          status: "edited",
          revision: 0,
        };
        const scenes = [...sb.scenes];
        scenes.splice(idx + 1, 0, scene);
        set({ selectedSceneId: id });
        return { ...sb, scenes };
      }),

    duplicateScene: (sceneId) =>
      commit((sb) => {
        if (sb.scenes.length >= MAX_SCENES) return sb;
        const idx = sb.scenes.findIndex((s) => s.id === sceneId);
        const src = sb.scenes[idx];
        if (!src) return sb;
        const id = uniqueId(src.id.replace(/-[a-z0-9]{5}$/, "").slice(0, 50), new Set(sb.scenes.map((s) => s.id)));
        const copy: Scene = { ...structuredClone(src), id, status: "edited", revision: 0 };
        const scenes = [...sb.scenes];
        scenes.splice(idx + 1, 0, copy);
        set({ selectedSceneId: id });
        return { ...sb, scenes };
      }),

    deleteScene: (sceneId) =>
      commit((sb) => {
        if (sb.scenes.length <= 1) return sb;
        const idx = sb.scenes.findIndex((s) => s.id === sceneId);
        const scenes = sb.scenes.filter((s) => s.id !== sceneId);
        if (get().selectedSceneId === sceneId) set({ selectedSceneId: scenes[Math.max(0, idx - 1)]?.id ?? null });
        return { ...sb, scenes };
      }),

    moveScene: (sceneId, delta) =>
      commit((sb) => {
        const idx = sb.scenes.findIndex((s) => s.id === sceneId);
        const to = idx + delta;
        if (idx < 0 || to < 0 || to >= sb.scenes.length) return sb;
        const scenes = [...sb.scenes];
        const [s] = scenes.splice(idx, 1);
        scenes.splice(to, 0, s!);
        return { ...sb, scenes };
      }),

    upsertSource: (source) =>
      commit((sb) => {
        const exists = sb.sources.some((s) => s.id === source.id);
        return { ...sb, sources: exists ? sb.sources.map((s) => (s.id === source.id ? source : s)) : [...sb.sources, source] };
      }),

    removeSource: (id) =>
      commit((sb) => ({
        ...sb,
        sources: sb.sources.filter((s) => s.id !== id),
        scenes: sb.scenes.map((s) =>
          s.sourceRefs.includes(id) || s.claims.some((c) => c.sourceRefIds.includes(id))
            ? touch({
                ...s,
                sourceRefs: s.sourceRefs.filter((r) => r !== id),
                claims: s.claims.map((c) => {
                  const ids = c.sourceRefIds.filter((r) => r !== id);
                  return { ...c, sourceRefIds: ids, status: c.status === "sourced" && ids.length === 0 ? "unsupported" : c.status };
                }),
              })
            : s,
        ),
      })),

    undo: () => {
      const { past, draft, future } = get();
      const prev = past[past.length - 1];
      if (!prev || !draft) return;
      set({ draft: prev, past: past.slice(0, -1), future: [draft, ...future] });
    },
    redo: () => {
      const { past, draft, future } = get();
      const next = future[0];
      if (!next || !draft) return;
      set({ draft: next, past: [...past, draft], future: future.slice(1) });
    },
  };
});

export function useIsDirty(): boolean {
  return useEditor((s) => (s.draft ? JSON.stringify(s.draft) !== s.saved : false));
}

export interface DraftCheck extends StoryboardValidationResult {
  /** Schema errors (malformed fields) that the server would reject outright. */
  schemaIssues: StoryboardIssue[];
}

/** Run the same schema + semantic checks the server runs, on the unsaved draft. */
export function checkDraft(draft: Storyboard): DraftCheck {
  const parsed = storyboardSchema.safeParse(draft);
  if (!parsed.success) {
    const schemaIssues: StoryboardIssue[] = parsed.error.issues.map((i) => {
      const sceneIdx = i.path[0] === "scenes" && typeof i.path[1] === "number" ? i.path[1] : -1;
      return {
        severity: "error",
        code: "schema",
        message: `${i.path.slice(sceneIdx >= 0 ? 2 : 0).join(".") || "storyboard"}: ${i.message}`,
        sceneId: sceneIdx >= 0 ? draft.scenes[sceneIdx]?.id : undefined,
        path: i.path.join("."),
      };
    });
    return { ok: false, errors: schemaIssues, warnings: [], schemaIssues };
  }
  return { ...validateStoryboard(parsed.data), schemaIssues: [] };
}
