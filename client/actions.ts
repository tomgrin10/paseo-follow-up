import type { ToastApi } from "@getpaseo/plugin/client/ui";
import { errorText } from "../shared/errors";

/**
 * Quick actions: the control that started one closes at once, and the outcome shows as a toast.
 *
 * STAND-IN. The real `runAction` and its global toast come with feat/quick-actions (a1b411b0's PR2). This file has the
 * same signature, `runAction({ label, run, success, failure, reopen? })`, so whichever PR lands second deletes this
 * stand-in and keeps its callers unchanged.
 */
export type ActionSpec<T> = {
  /** What runs, for the error toast's fallback and for logs ("Later", "Send repairs"). */
  label: string;
  run: () => Promise<T>;
  /** The success toast, or null for none (Sign off, whose Undo bar already says it). */
  success: string | null | ((result: T) => string | null);
  /** The failure toast; defaults to "<label> didn't work: <reason>". */
  failure?: string | ((error: unknown) => string);
  /** Called after a failure so the person can try again where they were (reopen the menu or card). */
  reopen?: () => void;
};

let toast: ToastApi | null = null;
const inflight = new Set<string>();

/** The host's toast, bound once by a mounted surface (Home binds it with useToast). */
export function bindToast(api: ToastApi | null): void { toast = api; }

/** Runs a quick action and reports it. Resolves true on success. A second identical action while one runs is dropped. */
export async function runAction<T>(spec: ActionSpec<T>, key: string = spec.label): Promise<boolean> {
  if (inflight.has(key)) return false;
  inflight.add(key);
  try {
    const result = await spec.run();
    const line = typeof spec.success === "function" ? spec.success(result) : spec.success;
    if (line) toast?.show(line, { variant: "success" });
    return true;
  } catch (error) {
    const line = typeof spec.failure === "function" ? spec.failure(error) : spec.failure ?? `${spec.label} didn't work: ${errorText(error)}`;
    toast?.error(line);
    spec.reopen?.();
    return false;
  } finally { inflight.delete(key); }
}
