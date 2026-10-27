import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./client";
import type { CaseDetail } from "./types";

export type Resource<T> =
  | { status: "loading"; data: T | undefined; error: undefined }
  | { status: "ready"; data: T; error: undefined }
  | { status: "error"; data: T | undefined; error: ApiError };

const cache = new Map<string, unknown>();

/** Drop cached responses after a mutation so the next screen reads fresh state. */
export function invalidate(prefix: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

/**
 * Loads a resource and keeps the last good value on screen while it reloads (stale while revalidate), so moving
 * between the screens of one case does not flash empty. Errors replace the loading state but keep the stale data.
 */
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Resource<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Resource<T>>(() =>
    key && cache.has(key) ? { status: "ready", data: cache.get(key) as T, error: undefined } : { status: "loading", data: undefined, error: undefined },
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (key === null) return;
    const ctl = new AbortController();
    const cached = cache.has(key) ? (cache.get(key) as T) : undefined;
    setState((s) => (cached !== undefined ? { status: "ready", data: cached, error: undefined } : { status: "loading", data: s.data && s.status !== "error" ? s.data : undefined, error: undefined }));
    loadRef
      .current(ctl.signal)
      .then((data) => {
        cache.set(key, data);
        setState({ status: "ready", data, error: undefined });
      })
      .catch((e: unknown) => {
        if ((e as Error).name === "AbortError") return;
        const err = e instanceof ApiError ? e : new ApiError("UNAVAILABLE", "Something went wrong while loading this.", 0);
        setState({ status: "error", data: cached, error: err });
      });
    return () => ctl.abort();
  }, [key, tick]);

  const reload = useCallback(() => {
    if (key) cache.delete(key);
    setTick((t) => t + 1);
  }, [key]);
  return { ...state, reload } as Resource<T> & { reload: () => void };
}

export const useCase = (id: string) => useResource<CaseDetail>(`case:${id}`, (s) => api.caseDetail(id, s));
