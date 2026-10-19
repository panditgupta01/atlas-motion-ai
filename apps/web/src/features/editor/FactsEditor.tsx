import { useState } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import type { Claim, Scene, SourceRef } from "@atlas/shared";
import { useEditor } from "../../stores/editor";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";

const STATUS_HELP: Record<Claim["status"], string> = {
  sourced: "Backed by at least one source below.",
  unsupported: "No source yet. Blocks rendering.",
  illustrative: "Not a factual claim (framing, transition, opinion).",
};

function slug(text: string, taken: Set<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "source";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export function ClaimsEditor({ scene }: { scene: Scene }) {
  const updateScene = useEditor((s) => s.updateScene);
  const sources = useEditor((s) => s.draft?.sources ?? []);
  const setClaims = (claims: Claim[]) => updateScene(scene.id, { claims });

  const setClaim = (i: number, c: Claim) => {
    // Keep status honest: a "sourced" claim needs a source; one with sources becomes sourced.
    let status = c.status;
    if (status === "sourced" && c.sourceRefIds.length === 0) status = "unsupported";
    if (status === "unsupported" && c.sourceRefIds.length > 0) status = "sourced";
    setClaims(scene.claims.map((x, j) => (j === i ? { ...c, status } : x)));
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">List each factual statement made in this scene's narration or on screen. Unsupported claims block rendering until you add a source, mark them illustrative, or remove them.</p>
      {scene.claims.map((c, i) => (
        <div key={i} className="space-y-2 rounded-md border border-line p-2.5">
          <div className="flex items-start gap-2">
            <Textarea rows={2} maxLength={500} aria-label="Claim text" value={c.text} onChange={(e) => setClaim(i, { ...c, text: e.target.value })} />
            <button type="button" aria-label="Remove claim" className="p-1 text-faint hover:text-danger" onClick={() => setClaims(scene.claims.filter((_, j) => j !== i))}>
              <Trash2 className="size-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select aria-label="Claim status" value={c.status} onChange={(e) => setClaim(i, { ...c, status: e.target.value as Claim["status"] })}>
              <option value="sourced" disabled={c.sourceRefIds.length === 0}>Sourced</option>
              <option value="unsupported">Unsupported</option>
              <option value="illustrative">Illustrative</option>
            </Select>
            <Select
              aria-label="Attach a source"
              value=""
              disabled={sources.length === 0}
              onChange={(e) => e.target.value && setClaim(i, { ...c, sourceRefIds: [...new Set([...c.sourceRefIds, e.target.value])], status: c.status === "illustrative" ? "illustrative" : "sourced" })}
            >
              <option value="">{sources.length ? "Attach source…" : "No sources yet"}</option>
              {sources.filter((s) => !c.sourceRefIds.includes(s.id)).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
          </div>
          <p className={`text-[11px] ${c.status === "unsupported" ? "text-danger" : "text-faint"}`}>{STATUS_HELP[c.status]}</p>
          {c.sourceRefIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {c.sourceRefIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 text-[11px]">
                  {sources.find((s) => s.id === id)?.title ?? id}
                  <button type="button" aria-label="Detach source" className="text-faint hover:text-danger" onClick={() => setClaim(i, { ...c, sourceRefIds: c.sourceRefIds.filter((x) => x !== id) })}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      {scene.claims.length < 20 && (
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setClaims([...scene.claims, { text: "New claim", sourceRefIds: [], status: "unsupported" }])}>
          Add claim
        </Button>
      )}
    </div>
  );
}

export function SourcesEditor() {
  const sources = useEditor((s) => s.draft?.sources ?? []);
  const { upsertSource, removeSource } = useEditor.getState();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const urlOk = !url || /^https?:\/\/\S+\.\S+/.test(url);

  const add = () => {
    const src: SourceRef = { id: slug(title, new Set(sources.map((s) => s.id))), title: title.trim(), url: url.trim() || undefined, kind: url ? "web" : "user_note", addedBy: "user", note: note.trim() || undefined };
    upsertSource(src);
    setTitle("");
    setUrl("");
    setNote("");
  };

  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {sources.map((s) => (
          <li key={s.id} className="flex items-start gap-2 rounded-md border border-line px-2.5 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate">{s.title}</p>
              <p className="text-[11px] text-faint">
                {s.kind} · added by {s.addedBy}
                {s.note ? ` · ${s.note}` : ""}
              </p>
              {s.url && (
                <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-[11px] text-info hover:underline">
                  {new URL(s.url).hostname} <ExternalLink className="size-3" />
                </a>
              )}
            </div>
            {s.addedBy !== "system" && (
              <button type="button" aria-label={`Remove ${s.title}`} className="p-1 text-faint hover:text-danger" onClick={() => removeSource(s.id)}>
                <Trash2 className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="space-y-2 rounded-md border border-dashed border-line p-2.5">
        <p className="text-xs font-medium text-muted">Add a source</p>
        <Input placeholder="Title, e.g. Central Water Commission report 2023" maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} />
        <Input placeholder="https://… (optional)" value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={!urlOk} />
        <Field label="Note (optional)">
          <Input maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {!urlOk && <p className="text-xs text-danger">Use an http(s) link.</p>}
        <Button size="sm" disabled={!title.trim() || !urlOk} onClick={add}>
          Add source
        </Button>
      </div>
    </div>
  );
}
