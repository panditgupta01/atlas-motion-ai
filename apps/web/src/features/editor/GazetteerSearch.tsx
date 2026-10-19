import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Search, Waves, Flag, Droplets } from "lucide-react";
import type { GazetteerHit } from "@atlas/shared";
import { api } from "../../services/api";
import { Input } from "../../components/ui";

const ICONS = { country: Flag, place: MapPin, river: Waves, lake: Droplets };

export function GazetteerSearch({ onPick, placeholder = "Search places, rivers, countries", kind }: { onPick: (hit: GazetteerHit) => void; placeholder?: string; kind?: GazetteerHit["kind"] }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const listId = useId();
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const results = useQuery({
    queryKey: ["gazetteer", q],
    enabled: q.length >= 2,
    staleTime: 5 * 60_000,
    queryFn: ({ signal }) => api.searchPlaces(q, signal),
  });
  const items = (results.data?.items ?? []).filter((h) => !kind || h.kind === kind);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
      <Input
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        aria-label={placeholder}
        placeholder={placeholder}
        className="pl-8"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && q.length >= 2 && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-line bg-surface-2 py-1 shadow-xl">
          {results.isFetching && items.length === 0 && <li className="px-3 py-2 text-xs text-faint">Searching…</li>}
          {!results.isFetching && items.length === 0 && <li className="px-3 py-2 text-xs text-faint">No match in the Natural Earth gazetteer.</li>}
          {items.map((h) => {
            const Icon = ICONS[h.kind];
            return (
              <li key={h.id} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left text-sm hover:bg-surface-3"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onPick(h);
                    setText("");
                    setOpen(false);
                  }}
                >
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-faint" />
                  <span className="min-w-0">
                    <span className="block truncate">
                      {h.name}
                      {h.nameHi && <span className="ml-1.5 text-muted">{h.nameHi}</span>}
                    </span>
                    <span className="block text-[11px] text-faint">
                      {h.kind}
                      {h.country ? ` · ${h.country}` : ""} · {h.latitude.toFixed(2)}, {h.longitude.toFixed(2)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
