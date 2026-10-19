import { Download, FileText, Film } from "lucide-react";
import type { MediaAssetDto } from "@atlas/shared";
import { inlineAssetUrl } from "../../services/api";
import { formatBytes } from "../../lib/format";

export function VideoOutput({ asset, subtitle }: { asset: MediaAssetDto; subtitle?: MediaAssetDto }) {
  const vertical = asset.format === "9:16";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <div className={vertical ? "mx-auto w-full max-w-[280px]" : "w-full"}>
        <video src={inlineAssetUrl(asset)} controls preload="metadata" playsInline className={`w-full rounded-md bg-black ${vertical ? "aspect-[9/16]" : "aspect-video"}`} />
      </div>
      <div className="flex items-start gap-2">
        <Film className="mt-0.5 size-4 shrink-0 text-faint" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">{asset.format} video</p>
          <p className="text-xs text-faint">
            {asset.width}×{asset.height} · {asset.fps} fps · {asset.durationSeconds?.toFixed(1)}s · {asset.videoCodec}
            {asset.audioCodec ? ` + ${asset.audioCodec}` : ", no audio"} · {formatBytes(asset.sizeBytes)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={asset.downloadUrl} download className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-[#1a1408] hover:bg-accent/90">
          <Download className="size-3.5" /> Download MP4
        </a>
        {subtitle && (
          <a href={subtitle.downloadUrl} download className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 text-[13px] hover:bg-surface-3">
            <FileText className="size-3.5" /> Subtitles (.srt)
          </a>
        )}
      </div>
    </div>
  );
}

/** Pair each video with the subtitle file of the same format. */
export function groupOutputs(outputs: MediaAssetDto[]) {
  const videos = outputs.filter((a) => a.kind === "video");
  return videos.map((v) => ({ video: v, subtitle: outputs.find((a) => a.kind === "subtitle" && a.format === v.format) }));
}
