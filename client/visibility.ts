import { AppState } from "react-native";

type Doc = { visibilityState?: string; addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void };
const doc = (): Doc | undefined => (globalThis as { document?: Doc }).document;

/**
 * Whether the app is in the foreground (1.3.0-beta.4). Background polls slow down instead of flooding the daemon
 * from a hidden window. Unknown counts as visible.
 */
export function appVisible(): boolean {
  try {
    const d = doc(); if (d?.visibilityState) return d.visibilityState === "visible";
    return AppState.currentState !== "background" && AppState.currentState !== "inactive";
  } catch { return true; }
}
/** Calls `wake` when the app comes back to the foreground, so a slowed poll refreshes right away. */
export function onVisible(wake: () => void): () => void {
  const subscription = (() => { try { return AppState.addEventListener("change", state => { if (state === "active") wake(); }); } catch { return null; } })();
  const listener = () => { if (appVisible()) wake(); };
  try { doc()?.addEventListener("visibilitychange", listener); } catch { /* no DOM */ }
  return () => { subscription?.remove(); try { doc()?.removeEventListener("visibilitychange", listener); } catch { /* no DOM */ } };
}
/**
 * Schedules the next run of a background poll: after `ms` while the app is in the foreground, never while it is
 * hidden (1.4.0: the stores pair this with `onVisible`, which polls once on return).
 */
export function whileVisible(ms: number, run: () => void): ReturnType<typeof setTimeout> | null {
  return appVisible() ? setTimeout(run, ms) : null;
}
/** The poll interval for now: `visibleMs` in the foreground, `hiddenMs` otherwise. */
export const pollDelay = (visibleMs: number, hiddenMs: number): number => appVisible() ? visibleMs : hiddenMs;
