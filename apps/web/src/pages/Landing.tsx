import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, FileVideo, Globe2, ListChecks, Map, ShieldCheck, X } from "lucide-react";
import { Logo } from "../components/Layout";
import { Button } from "../components/ui";
import { useMe } from "../hooks/queries";

interface SampleManifest {
  items: { file: string; format: "9:16" | "16:9"; prompt: string; language: string; durationSeconds: number; renderedAt: string }[];
}

/** Sample videos are produced by `pnpm sample:render -- --publish` and listed in a manifest. None are faked. */
function useSamples() {
  const [samples, setSamples] = useState<SampleManifest["items"]>([]);
  useEffect(() => {
    fetch("/samples/manifest.json")
      .then((r) => (r.ok ? (r.json() as Promise<SampleManifest>) : { items: [] }))
      .then((m) => setSamples(m.items ?? []))
      .catch(() => setSamples([]));
  }, []);
  return samples;
}

const STEPS = [
  { icon: ListChecks, title: "Describe the story", body: "Write a prompt in English or Hindi. The planner turns it into scenes: places, camera moves, overlays and narration." },
  { icon: Map, title: "Review every scene", body: "Edit coordinates, labels, timing and narration. Claims without a source are flagged and block the render until you resolve them." },
  { icon: FileVideo, title: "Render real MP4s", body: "A background worker draws each frame from Natural Earth vector data and encodes 9:16 and 16:9 videos with FFmpeg." },
];

const CAN = [
  "Animated 2D globe and map views with zooms, pans and route reveals",
  "Country highlights, rivers, lakes, markers, arrows, legends and title cards",
  "Hindi and English captions burned in or as an .srt file",
  "Synthetic narration with espeak-ng (robotic, but real and offline)",
  "Per-scene caching, retries and cancellation",
];
const CANNOT = [
  "3D terrain or satellite imagery (not implemented)",
  "Flood extents, basins or live data (no dataset bundled)",
  "Facts you have not sourced: the app will not invent them",
];

export function LandingPage() {
  const me = useMe();
  const samples = useSamples();
  const signedIn = !!me.data;

  return (
    <div className="min-h-full">
      <header className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6">
        <Logo />
        <div className="ml-auto flex items-center gap-2">
          {signedIn ? (
            <Link to="/dashboard">
              <Button variant="primary" size="sm">Open projects</Button>
            </Link>
          ) : (
            <>
              <Link to="/login">
                <Button variant="ghost" size="sm">Sign in</Button>
              </Link>
              <Link to="/register">
                <Button variant="primary" size="sm">Create account</Button>
              </Link>
            </>
          )}
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pt-14 pb-16 sm:px-6 lg:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-xs text-muted">
              <Globe2 className="size-3.5 text-accent" /> Map documentaries from a prompt
            </p>
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight sm:text-5xl">
              Turn a geography story into an animated map video.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              AtlasMotion plans the scenes, lets you check every place and claim, then renders vertical and widescreen MP4s with captions and narration.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={signedIn ? "/projects/new" : "/register"}>
                <Button variant="primary">Start a project</Button>
              </Link>
              <a href="#how">
                <Button>How it works</Button>
              </a>
            </div>
          </div>
          <div className="flex items-end justify-center gap-4">
            {samples.length > 0 ? (
              samples.slice(0, 2).map((s) => (
                <figure key={s.file} className={s.format === "9:16" ? "w-[34%]" : "w-[66%]"}>
                  <video src={`/samples/${s.file}`} className="w-full rounded-lg border border-line bg-black" controls muted loop playsInline preload="metadata" />
                  <figcaption className="mt-2 text-xs text-faint">
                    {s.format} sample, rendered by this app ({s.durationSeconds}s, {s.language === "hi" ? "Hindi" : "English"})
                  </figcaption>
                </figure>
              ))
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-line text-center text-sm text-faint">
                No sample video has been published on this server yet.
                <br />
                Run <code className="mx-1 text-muted">pnpm sample:render --publish</code> to add one.
              </div>
            )}
          </div>
        </div>
      </section>

      <section id="how" className="border-t border-line bg-surface/40">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 sm:px-6 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <div key={s.title}>
              <div className="mb-3 flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-md bg-surface-2 text-accent">
                  <s.icon className="size-4" />
                </span>
                <span className="text-xs text-faint">Step {i + 1}</span>
              </div>
              <h3 className="font-medium">{s.title}</h3>
              <p className="mt-1.5 text-sm text-muted">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold">What it does today</h2>
          <ul className="mt-4 space-y-2.5">
            {CAN.map((c) => (
              <li key={c} className="flex gap-2.5 text-sm text-muted">
                <Check className="mt-0.5 size-4 shrink-0 text-ok" /> {c}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="text-lg font-semibold">What it does not do</h2>
          <ul className="mt-4 space-y-2.5">
            {CANNOT.map((c) => (
              <li key={c} className="flex gap-2.5 text-sm text-muted">
                <X className="mt-0.5 size-4 shrink-0 text-faint" /> {c}
              </li>
            ))}
          </ul>
          <p className="mt-6 flex gap-2.5 text-sm text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
            Coordinates come from the Natural Earth gazetteer, not from the language model. Every scene shows where its data came from.
          </p>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-faint sm:px-6">
          <span>Map data: Natural Earth (public domain). Fonts: Noto Sans (OFL).</span>
          <a href="/api/v1/docs/openapi.json" className="hover:text-muted">API reference (OpenAPI)</a>
        </div>
      </footer>
    </div>
  );
}
