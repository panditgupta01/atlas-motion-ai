import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { GazetteerHit, Overlay, OverlayType, Scene } from "@atlas/shared";
import { useEditor } from "../../stores/editor";
import { Button, Checkbox, Field, Input, Select } from "../../components/ui";
import { GazetteerSearch } from "./GazetteerSearch";

const TYPE_LABELS: Record<OverlayType, string> = {
  title_card: "Title card",
  location_label: "Location label",
  marker: "Marker",
  highlight_country: "Highlight country",
  river: "River",
  route: "Route",
  arrow: "Arrow",
  legend: "Legend",
};

function newOverlay(type: OverlayType, scene: Scene): Overlay {
  const { latitude, longitude, name } = scene.location;
  switch (type) {
    case "title_card":
      return { type, text: scene.title || name };
    case "location_label":
      return { type, text: name, latitude, longitude };
    case "marker":
      return { type, latitude, longitude, label: name, pulse: true };
    case "highlight_country":
      return { type, iso3: "IND" };
    case "river":
      return { type, datasetName: "Ganges", animate: true };
    case "route":
      return { type, coordinates: [[longitude, latitude], [longitude + 2, latitude]], animate: true };
    case "arrow":
      return { type, from: [longitude - 2, latitude], to: [longitude, latitude] };
    case "legend":
      return { type, items: [{ label: "Highlighted area", color: "#e0b04c" }] };
  }
}

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function LatLon({ lat, lon, onChange }: { lat: number; lon: number; onChange: (lat: number, lon: number) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="Latitude">
        <Input type="number" step="0.0001" min={-90} max={90} value={lat} onChange={(e) => onChange(num(e.target.value), lon)} />
      </Field>
      <Field label="Longitude">
        <Input type="number" step="0.0001" min={-180} max={180} value={lon} onChange={(e) => onChange(lat, num(e.target.value))} />
      </Field>
    </div>
  );
}

function OverlayFields({ overlay, set }: { overlay: Overlay; set: (o: Overlay) => void }) {
  switch (overlay.type) {
    case "title_card":
      return (
        <>
          <Field label="Title">
            <Input maxLength={80} value={overlay.text} onChange={(e) => set({ ...overlay, text: e.target.value })} />
          </Field>
          <Field label="Subtitle">
            <Input maxLength={120} value={overlay.subtitle ?? ""} onChange={(e) => set({ ...overlay, subtitle: e.target.value || undefined })} />
          </Field>
        </>
      );
    case "location_label":
      return (
        <>
          <Field label="Text">
            <Input maxLength={120} value={overlay.text} onChange={(e) => set({ ...overlay, text: e.target.value })} />
          </Field>
          <GazetteerSearch placeholder="Snap to a gazetteer place" onPick={(h) => set({ ...overlay, latitude: h.latitude, longitude: h.longitude })} />
          <LatLon lat={overlay.latitude} lon={overlay.longitude} onChange={(latitude, longitude) => set({ ...overlay, latitude, longitude })} />
        </>
      );
    case "marker":
      return (
        <>
          <Field label="Label">
            <Input maxLength={120} value={overlay.label ?? ""} onChange={(e) => set({ ...overlay, label: e.target.value || undefined })} />
          </Field>
          <GazetteerSearch placeholder="Snap to a gazetteer place" onPick={(h) => set({ ...overlay, latitude: h.latitude, longitude: h.longitude, label: overlay.label ?? h.name })} />
          <LatLon lat={overlay.latitude} lon={overlay.longitude} onChange={(latitude, longitude) => set({ ...overlay, latitude, longitude })} />
          <Checkbox label="Pulse" checked={overlay.pulse} onChange={(pulse) => set({ ...overlay, pulse })} />
        </>
      );
    case "highlight_country":
      return (
        <>
          <GazetteerSearch kind="country" placeholder="Find a country" onPick={(h: GazetteerHit) => h.iso3 && set({ ...overlay, iso3: h.iso3, label: overlay.label ?? h.name })} />
          <div className="grid grid-cols-2 gap-2">
            <Field label="ISO3 code" hint="Natural Earth ADM0_A3">
              <Input maxLength={3} value={overlay.iso3} onChange={(e) => set({ ...overlay, iso3: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Color">
              <Input type="color" className="p-1" value={overlay.color ?? "#e0b04c"} onChange={(e) => set({ ...overlay, color: e.target.value })} />
            </Field>
          </div>
          <Field label="Label">
            <Input maxLength={120} value={overlay.label ?? ""} onChange={(e) => set({ ...overlay, label: e.target.value || undefined })} />
          </Field>
        </>
      );
    case "river":
      return (
        <>
          <GazetteerSearch kind="river" placeholder="Find a river in the dataset" onPick={(h) => set({ ...overlay, datasetName: h.id.replace(/^river:/, ""), label: overlay.label ?? h.name })} />
          <Field label="Dataset name" hint="Exact Natural Earth river name. Rivers missing from the dataset cannot be drawn.">
            <Input maxLength={120} value={overlay.datasetName} onChange={(e) => set({ ...overlay, datasetName: e.target.value })} />
          </Field>
          <Field label="Label">
            <Input maxLength={120} value={overlay.label ?? ""} onChange={(e) => set({ ...overlay, label: e.target.value || undefined })} />
          </Field>
          <Checkbox label="Animate the river being drawn" checked={overlay.animate} onChange={(animate) => set({ ...overlay, animate })} />
        </>
      );
    case "route":
      return (
        <>
          <Field label="Points (longitude, latitude per line)" hint={`${overlay.coordinates.length} points, 2 to 500.`}>
            <textarea
              className="h-28 w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs"
              defaultValue={overlay.coordinates.map((c) => c.join(", ")).join("\n")}
              onBlur={(e) => {
                const coords = e.target.value
                  .split("\n")
                  .map((l) => l.split(/[,\s]+/).filter(Boolean).map(Number))
                  .filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][];
                if (coords.length >= 2) set({ ...overlay, coordinates: coords.slice(0, 500) });
              }}
            />
          </Field>
          <Field label="Label">
            <Input maxLength={120} value={overlay.label ?? ""} onChange={(e) => set({ ...overlay, label: e.target.value || undefined })} />
          </Field>
          <Checkbox label="Animate the route" checked={overlay.animate} onChange={(animate) => set({ ...overlay, animate })} />
        </>
      );
    case "arrow":
      return (
        <>
          <p className="text-xs text-faint">From</p>
          <LatLon lat={overlay.from[1]} lon={overlay.from[0]} onChange={(lat, lon) => set({ ...overlay, from: [lon, lat] })} />
          <p className="text-xs text-faint">To</p>
          <LatLon lat={overlay.to[1]} lon={overlay.to[0]} onChange={(lat, lon) => set({ ...overlay, to: [lon, lat] })} />
          <Field label="Label">
            <Input maxLength={120} value={overlay.label ?? ""} onChange={(e) => set({ ...overlay, label: e.target.value || undefined })} />
          </Field>
        </>
      );
    case "legend":
      return (
        <div className="space-y-2">
          {overlay.items.map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input type="color" className="w-12 p-1" value={item.color} onChange={(e) => set({ ...overlay, items: overlay.items.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)) })} />
              <Input maxLength={120} value={item.label} onChange={(e) => set({ ...overlay, items: overlay.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <button type="button" aria-label="Remove item" className="p-1 text-faint hover:text-danger disabled:opacity-30" disabled={overlay.items.length <= 1} onClick={() => set({ ...overlay, items: overlay.items.filter((_, j) => j !== i) })}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          {overlay.items.length < 6 && (
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => set({ ...overlay, items: [...overlay.items, { label: "Item", color: "#5aa7e0" }] })}>
              Add item
            </Button>
          )}
        </div>
      );
  }
}

function summary(o: Overlay): string {
  switch (o.type) {
    case "title_card":
    case "location_label":
      return o.text;
    case "marker":
      return o.label ?? `${o.latitude.toFixed(2)}, ${o.longitude.toFixed(2)}`;
    case "highlight_country":
      return o.label ? `${o.label} (${o.iso3})` : o.iso3;
    case "river":
      return o.label ?? o.datasetName;
    case "route":
      return o.label ?? `${o.coordinates.length} points`;
    case "arrow":
      return o.label ?? "arrow";
    case "legend":
      return `${o.items.length} item${o.items.length > 1 ? "s" : ""}`;
  }
}

export function OverlayEditor({ scene }: { scene: Scene }) {
  const updateScene = useEditor((s) => s.updateScene);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<OverlayType>("marker");
  const setOverlays = (overlays: Overlay[]) => updateScene(scene.id, { overlays });

  return (
    <div className="space-y-3">
      {scene.overlays.length === 0 && <p className="text-sm text-faint">No overlays in this scene.</p>}
      <ul className="space-y-2">
        {scene.overlays.map((o, i) => (
          <li key={`${scene.id}-${i}`} className="rounded-md border border-line">
            <div className="flex items-center gap-2 px-2.5 py-2">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                <ChevronDown className={`size-3.5 shrink-0 text-faint transition-transform ${open === i ? "" : "-rotate-90"}`} />
                <span className="text-xs text-muted">{TYPE_LABELS[o.type]}</span>
                <span className="truncate text-sm">{summary(o)}</span>
              </button>
              <button type="button" aria-label="Remove overlay" className="p-1 text-faint hover:text-danger" onClick={() => setOverlays(scene.overlays.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
            {open === i && (
              <div className="space-y-3 border-t border-line p-3">
                <OverlayFields overlay={o} set={(next) => setOverlays(scene.overlays.map((x, j) => (j === i ? next : x)))} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {scene.overlays.length < 20 && (
        <div className="flex gap-2">
          <Select aria-label="Overlay type" value={adding} onChange={(e) => setAdding(e.target.value as OverlayType)}>
            {(Object.keys(TYPE_LABELS) as OverlayType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Button
            icon={<Plus className="size-4" />}
            onClick={() => {
              setOverlays([...scene.overlays, newOverlay(adding, scene)]);
              setOpen(scene.overlays.length);
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
