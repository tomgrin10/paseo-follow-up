import { useEffect, useRef } from "react";
import type { ToastApi } from "@getpaseo/plugin/client/ui";
import { errorText } from "../shared/errors";

/**
 * Follow-up's one toast system, the part without React Native: the store, `runAction` and the question openers.
 * ToastHost (client/toasts.tsx) draws it. Paseo's toast API shows one message at a time with no buttons and no toast
 * that stays, so an error with Retry and Open can't go through it; with no ToastHost mounted, runAction falls back to
 * the host toast, so nothing is lost silently.
 */

export type ToastTone = "success" | "info" | "warning" | "error";
export type ToastAction = { label: string; onPress: () => void };
export type ToastItem = { id: number; tone: ToastTone; message: string; actions: ToastAction[]; sticky: boolean };

const MAX = 3;
const DURATION_MS = 4_000;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
export const hosts: number[] = [];
export const emit = () => { for (const l of listeners) l(); };
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Shows a toast. Errors stay until dismissed; the rest go after ~4 s. At most three: the oldest non-error goes first. */
export function pushToast(tone: ToastTone, message: string, actions: ToastAction[] = []): number {
  const id = nextId++;
  const sticky = tone === "error";
  items = [...items, { id, tone, message, actions, sticky }];
  while (items.length > MAX) {
    const drop = items.findIndex(t => !t.sticky);
    items = items.filter((_, i) => i !== (drop >= 0 ? drop : 0));
  }
  emit();
  if (!sticky) setTimeout(() => dismissToast(id), DURATION_MS);
  return id;
}

export function dismissToast(id: number) {
  if (!items.some(t => t.id === id)) return;
  items = items.filter(t => t.id !== id); emit();
}

/** True while a ToastHost is mounted somewhere in Follow-up. */
export const hasToastHost = () => hosts.length > 0;

/** Test seam: the store's current toasts. */
export const toastsNow = () => items;

type Done = { tone?: ToastTone; message: string } | string | null;
export type ActionSpec<T> = {
  /** What runs ("Later", "Send repairs"): the failure toast's default subject. */
  label: string;
  run: () => Promise<T>;
  /** The success toast, or null for none (a card or Undo bar that already says it). Throwing here counts as a failure. */
  success: Done | ((result: T) => Done);
  /** The failure toast's text, e.g. "Answer to Q24 not sent"; the reason follows it. Defaults to "<label> didn't work". */
  failure?: string | ((error: unknown) => string);
  /** The error toast's Open: brings the card back with what the developer entered. */
  open?: () => void;
  /** Called after a failure so the developer can try again where they were (reopen the menu or card). */
  reopen?: () => void;
  /** The host toast, from `useToast()` where the action started; otherwise the one a surface bound (bindToast). */
  toast?: ToastApi;
  /** Runs after a failure, before the toast: keep the input, mark the card. */
  onError?: (error: unknown) => void;
  onSuccess?: (result: T) => void;
};

let boundToast: ToastApi | null = null;
/** The host toast for callers that can't pass one (the row menu), bound once by a mounted surface. */
export function bindToast(api: ToastApi | null): void { boundToast = api; }
const inflight = new Set<string>();

/**
 * A quick action: the caller closes its dialog, menu or card first, then this runs the work in the background and
 * reports the outcome as a toast. Failure keeps a Retry (the same action again) and, when given, an Open that brings
 * the card back with what the developer entered. Without a mounted ToastHost the host toast says it instead.
 * With a `key`, a second identical action while one runs is dropped. Resolves true on success.
 */
export async function runAction<T>(opts: ActionSpec<T>, key?: string): Promise<boolean> {
  if (key !== undefined) { if (inflight.has(key)) return false; inflight.add(key); }
  const toast = opts.toast ?? boundToast ?? undefined;
  try {
    const result = await opts.run();
    const raw = typeof opts.success === "function" ? opts.success(result) : opts.success;
    opts.onSuccess?.(result);
    const done = typeof raw === "string" ? { message: raw } : raw;
    if (done) {
      if (hasToastHost()) pushToast(done.tone ?? "success", done.message);
      else toast?.show(done.message, { variant: done.tone ?? "success" });
    }
    return true;
  } catch (error) {
    opts.onError?.(error);
    const failure = typeof opts.failure === "function" ? opts.failure(error) : opts.failure ?? `${opts.label} didn't work`;
    const reason = errorText(error);
    if (hasToastHost()) {
      const actions: ToastAction[] = [{ label: "Retry", onPress: () => void runAction(opts, key) }];
      if (opts.open) actions.push({ label: "Open", onPress: opts.open });
      pushToast("error", `${failure}. ${reason}`, actions);
    } else toast?.error(`${failure}. ${opts.open ? "Retry from Needs you." : reason}`);
    opts.reopen?.();
    return false;
  } finally { if (key !== undefined) inflight.delete(key); }
}

// ---------- Open: a toast's way back to the question it is about ----------

const openers = new Map<string, ((questionId: string) => void)[]>();

/** Registers a surface that can show a workspace's question dialog (Home's detail pane, the panel). */
export function useQuestionOpener(workspaceId: string | undefined, open: (questionId: string) => void) {
  const latest = useRef(open); latest.current = open;
  useEffect(() => {
    if (!workspaceId) return;
    const fn = (id: string) => latest.current(id);
    openers.set(workspaceId, [...openers.get(workspaceId) ?? [], fn]);
    return () => { const left = (openers.get(workspaceId) ?? []).filter(f => f !== fn); if (left.length) openers.set(workspaceId, left); else openers.delete(workspaceId); };
  }, [workspaceId]);
}

/** Opens the question in the most recently mounted surface for its workspace. False when none is mounted. */
export function openQuestion(workspaceId: string, questionId: string): boolean {
  const list = openers.get(workspaceId);
  if (!list?.length) return false;
  list[list.length - 1](questionId);
  return true;
}
