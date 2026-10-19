import type {
  ApiErrorBody,
  CreateProjectRequest,
  CreateRenderRequest,
  GazetteerHit,
  HealthDto,
  MediaAssetDto,
  Paginated,
  ProjectDto,
  ProjectOptions,
  ProviderStatusDto,
  RenderJobDto,
  Storyboard,
  StoryboardDto,
  UserDto,
} from "@atlas/shared";
import type { FeatureCollection } from "geojson";

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api/v1";

/** An error returned by the API, with its machine-readable code and any details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: "include",
      // The API rejects state-changing requests without this header (CSRF defence).
      headers: { "X-Atlas-Client": "web", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Could not reach the AtlasMotion API. Check that the server is running.");
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    // Non-JSON body (proxy error page etc.)
  }
  if (!res.ok) {
    const e = (data as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (${res.status}).`, e?.details, e?.requestId);
  }
  return data as T;
}

export interface ListProjectsParams {
  page?: number;
  pageSize?: number;
  q?: string;
  sort?: "updatedAt" | "createdAt" | "title";
  order?: "asc" | "desc";
}

function qs(params: object): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
}

export const api = {
  me: () => request<{ user: UserDto }>("GET", "/auth/me"),
  login: (email: string, password: string) => request<{ user: UserDto }>("POST", "/auth/login", { email, password }),
  register: (email: string, password: string) => request<{ user: UserDto }>("POST", "/auth/register", { email, password }),
  logout: () => request<void>("POST", "/auth/logout"),

  health: () => request<HealthDto>("GET", "/health"),
  providers: () => request<{ items: ProviderStatusDto[] }>("GET", "/providers"),

  listProjects: (p: ListProjectsParams) => request<Paginated<ProjectDto>>("GET", `/projects${qs(p)}`),
  getProject: (id: string) => request<{ project: ProjectDto }>("GET", `/projects/${id}`),
  createProject: (body: CreateProjectRequest) => request<{ project: ProjectDto }>("POST", "/projects", body),
  updateProject: (id: string, body: { title?: string; prompt?: string; options?: Partial<ProjectOptions> }) => request<{ project: ProjectDto }>("PATCH", `/projects/${id}`, body),
  deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),
  projectAssets: (id: string) => request<{ items: MediaAssetDto[] }>("GET", `/projects/${id}/assets`),

  generateStoryboard: (id: string, provider?: string) =>
    request<StoryboardDto & { attempts: number }>("POST", `/projects/${id}/storyboard`, provider ? { provider } : {}),
  getStoryboard: (id: string) => request<StoryboardDto>("GET", `/projects/${id}/storyboard`),
  saveStoryboard: (id: string, storyboard: Storyboard, baseVersion: number) =>
    request<StoryboardDto>("PATCH", `/projects/${id}/storyboard`, { storyboard, baseVersion }),
  regenerateScene: (id: string, sceneId: string, baseVersion: number, instructions?: string) =>
    request<StoryboardDto>("POST", `/projects/${id}/scenes/${sceneId}/regenerate`, { baseVersion, instructions: instructions || undefined }),

  createRender: (id: string, body: CreateRenderRequest) => request<{ render: RenderJobDto }>("POST", `/projects/${id}/renders`, body),
  listRenders: (id: string) => request<{ items: RenderJobDto[] }>("GET", `/projects/${id}/renders`),
  getRender: (renderId: string) => request<{ render: RenderJobDto }>("GET", `/renders/${renderId}`),
  cancelRender: (renderId: string) => request<{ render: RenderJobDto }>("POST", `/renders/${renderId}/cancel`),
  retryRender: (renderId: string) => request<{ render: RenderJobDto }>("POST", `/renders/${renderId}/retry`, {}),

  overlayFeatures: (countries: string[], rivers: string[]) =>
    request<FeatureCollection>("GET", `/geo/overlay-features${qs({ countries: countries.join(",") || undefined, rivers: rivers.join("|") || undefined })}`),
  imagery: () => request<ImageryInfo>("GET", "/geo/imagery"),
  searchPlaces: (q: string, signal?: AbortSignal) => request<{ items: GazetteerHit[]; attribution: string }>("GET", `/geo/search${qs({ q, limit: 8 })}`, undefined, signal),
};

/** URL for streaming an asset in the browser (video element, image). */
export function inlineAssetUrl(asset: { downloadUrl: string } | string): string {
  const url = typeof asset === "string" ? `${BASE}/assets/${asset}/download` : asset.downloadUrl;
  return `${url}${url.includes("?") ? "&" : "?"}inline=1`;
}

export interface ImageryInfo {
  provider: string;
  label: string;
  license: string;
  attribution: string[];
  detail: boolean;
  maxZoom: number;
  tiles: string;
  /** Elevation tiles for the 3D view; null when the server has terrain off. */
  terrain: { tiles: string; encoding: "terrarium"; maxZoom: number; attribution: string } | null;
}

/** Absolute tile URL template: MapLibre fetches tiles from a worker, where relative URLs do not resolve. */
export function imageryTileUrl(): string {
  const path = `${BASE}/geo/imagery/tiles/{z}/{x}/{y}`;
  return path.startsWith("/") ? `${window.location.origin}${path}` : path;
}

export function terrainTileUrl(): string {
  const path = `${BASE}/geo/terrain/{z}/{x}/{y}`;
  return path.startsWith("/") ? `${window.location.origin}${path}` : path;
}

export function layerUrl(layer: "countries" | "rivers" | "lakes" | "countries-detail" | "rivers-detail"): string {
  return `${BASE}/geo/layers/${layer}`;
}
