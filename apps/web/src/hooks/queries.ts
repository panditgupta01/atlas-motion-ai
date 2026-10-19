import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTerminal, type RenderJobDto } from "@atlas/shared";
import { api, ApiError, type ListProjectsParams } from "../services/api";

export const keys = {
  me: ["me"] as const,
  projects: (p: ListProjectsParams) => ["projects", p] as const,
  project: (id: string) => ["project", id] as const,
  storyboard: (id: string) => ["storyboard", id] as const,
  renders: (id: string) => ["renders", id] as const,
  render: (id: string) => ["render", id] as const,
  providers: ["providers"] as const,
  health: ["health"] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return (await api.me()).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useProjects(params: ListProjectsParams) {
  return useQuery({ queryKey: keys.projects(params), queryFn: () => api.listProjects(params), placeholderData: keepPreviousData });
}

export function useProject(id: string) {
  return useQuery({ queryKey: keys.project(id), queryFn: async () => (await api.getProject(id)).project });
}

export function useStoryboard(id: string, enabled = true) {
  return useQuery({
    queryKey: keys.storyboard(id),
    enabled,
    queryFn: async () => {
      try {
        return await api.getStoryboard(id);
      } catch (err) {
        if (err instanceof ApiError && err.code === "no_storyboard") return null;
        throw err;
      }
    },
    // The editor owns the draft once loaded; do not refetch underneath it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useRenders(projectId: string) {
  return useQuery({
    queryKey: keys.renders(projectId),
    queryFn: async () => (await api.listRenders(projectId)).items,
    refetchInterval: (q) => (q.state.data?.some((r) => !isTerminal(r.status)) ? 3000 : false),
  });
}

/** Polls a render while it is active; stops once it reaches a terminal state. */
export function useRender(renderId: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.render(renderId ?? "none"),
    enabled: !!renderId,
    queryFn: async () => {
      const r = (await api.getRender(renderId!)).render;
      if (isTerminal(r.status)) {
        void qc.invalidateQueries({ queryKey: keys.renders(r.projectId) });
        void qc.invalidateQueries({ queryKey: keys.project(r.projectId) });
      }
      return r;
    },
    refetchInterval: (q) => {
      const r = q.state.data as RenderJobDto | undefined;
      return r && isTerminal(r.status) ? false : 1500;
    },
  });
}

export function useProviders() {
  return useQuery({ queryKey: keys.providers, queryFn: async () => (await api.providers()).items, staleTime: 60_000 });
}

export function useHealth() {
  return useQuery({ queryKey: keys.health, queryFn: api.health, staleTime: 30_000, retry: false });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      qc.setQueryData(keys.me, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
  });
}
