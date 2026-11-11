import { useEffect, useRef } from "react";
import type { ToastApi } from "@getpaseo/plugin/client/ui";
import { errorText, sentence } from "../shared/errors";

/**
 * Follow-up's one toast system, the part without React Native: the store, `runAction` and the question openers.
 * ToastHost (client/toasts.tsx) draws it. Paseo's toast API shows one message at a time with no buttons and no toast
 * that stays, so an error with Retry and Open can't go through it; with no ToastHost mounted, runAction falls back to
 * the host toast, so nothing is lost silently.
 */

export type ToastTone = "success" | "info" | "warning" | "error";
export type ToastAction = { label: string; onPress: () => void };
export type ToastItem = { id: number; tone: ToastTone; message: string; actions: ToastAction[]; sticky: boolean;
  /** Not dropped to make room while it lasts (an Undo window whose work waits on it). */
  keep?: boolean };
/** How long a toast lasts, whether it is kept, and what runs when it times out (not when it's dismissed or acted on). */
export type ToastOptions = { durationMs?: number; keep?: boolean; onExpire?: () => void };

const MAX = 3;
const DURATION_MS = 4_000;
let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
export const hosts: number[] = [];
export const emit = () => { for (const l of listeners) l(); };
export const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

type Timer = { handle: ReturnType<typeof setTimeout> | null; left: number; since: number; onExpire?: () => void };
const timers = new Map<number, Timer>();
function arm(id: number, t: Timer) {
  t.since = Date.now();
  t.handle = setTimeout(() => { timers.delete(id); const live = items.some(x => x.id === id); dismissToast(id); if (live) t.onExpire?.(); }, t.left);
}

/**
 * Shows a toast. Errors stay until dismissed; the rest go after ~4 s (or `durationMs`). At most three: the oldest
 * toast that is neither an error nor kept goes first. A dropped toast never runs its `onExpire`.
 */
export function pushToast(tone: ToastTone, message: string, actions: ToastAction[] = [], options: ToastOptions = {}): number {
  const id = nextId++;
  const sticky = tone === "error";
  items = [...items, { id, tone, message, actions, sticky, ...(options.keep ? { keep: true } : {}) }];
  while (items.length > MAX) {
    const drop = items.findIndex(t => !t.sticky && !t.keep);
    if (drop < 0) break;
    dismissToast(items[drop].id);
  }
  emit();
  if (!sticky) { const t: Timer = { handle: null, left: options.durationMs ?? DURATION_MS, since: 0, onExpire: options.onExpire }; timers.set(id, t); arm(id, t); }
  return id;
}

/** While the pointer rests on a toast or focus is in it, its time stops: an Undo you're reaching for never runs out. */
export function holdToast(id: number, held: boolean) {
  const t = timers.get(id); if (!t) return;
  if (held && t.handle) { clearTimeout(t.handle); t.handle = null; t.left = Math.max(800, t.left - (Date.now() - t.since)); }
  else if (!held && !t.handle) arm(id, t);
}

export function dismissToast(id: number) {
  const t = timers.get(id); if (t?.handle) clearTimeout(t.handle); timers.delete(id);
  if (!items.some(x => x.id === id)) return;
  items = items.filter(x => x.id !== id); emit();
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
      // With Open, the toast is one line, as narrow as Paseo's own: the reason lives on the surface Open returns to.
      pushToast("error", opts.open ? failure : `${sentence(failure)} ${sentence(reason)}`, actions);
    } else toast?.error(`${sentence(failure)} ${opts.open ? "Retry from Needs you." : sentence(reason)}`);
    opts.reopen?.();
    return false;
  } finally { if (key !== undefined) inflight.delete(key); }
}

/**
 * A quick action whose message can't be taken back once sent (Done on an Action brief): the toast says `message` with
 * Undo, and the work starts only when the toast's window ends. Undo inside the window cancels it and nothing is sent;
 * a reload inside it also sends nothing, which is the safe side. With no ToastHost there is no Undo to show, so the
 * work runs at once and the host toast confirms with `success`.
 */
export function runUndoable<T>(message: string, opts: ActionSpec<T>, onUndo: () => void, key?: string, onEnd?: () => void): number | null {
  if (!hasToastHost()) { void runAction(opts, key); return null; }
  // Nothing has happened yet, so the tone is neutral, not success. The window matches sign-off's Undo (6 s), is
  // never pushed out by newer toasts, and holds while the pointer or focus is on it. The send runs only when it
  // times out: Undo (or dismissing it) cancels. After the send, the collapsed card is the confirmation; a failure
  // still reports with Retry.
  return pushToast("info", message, [{ label: "Undo", onPress: () => { onEnd?.(); onUndo(); } }], { durationMs: UNDO_WINDOW_MS, keep: true,
    onExpire: () => { void runAction({ ...opts, success: null }, key).finally(() => onEnd?.()); } });
}

export type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: unknown };
/**
 * Ctrl+Z (Cmd+Z on a Mac) while an Undo toast shows: the newest one's Undo, as if pressed. Only then, and never while
 * typing (a text field keeps its own undo) or with Shift (redo). True when it acted, so the caller stops the key.
 */
export function undoShortcut(e: KeyLike, mac: boolean): boolean {
  if (e.key.toLowerCase() !== "z" || e.shiftKey || e.altKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(t.tagName ?? ""))) return false;
  const toast = [...items].reverse().find(x => x.actions.some(a => a.label === "Undo"));
  if (!toast) return false;
  const undo = toast.actions.find(a => a.label === "Undo")!;
  dismissToast(toast.id); undo.onPress();
  return true;
}
/** The same 6 s as a sign-off's Undo. */
export const UNDO_WINDOW_MS = 6_000;

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
