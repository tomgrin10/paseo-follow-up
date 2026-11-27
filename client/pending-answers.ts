import { useSyncExternalStore } from "react";
import type { ImageUpload } from "../shared/images";
import type { AnswerHow } from "../shared/optimistic-answers";
import { dropUnsent, keepUnsent } from "./unsent-images";

/**
 * Answers the developer sent that the client's copy doesn't show yet (answering-is-optimistic, invariant 138). Every
 * surface reads its workspaces through this store's overlay (shared/optimistic-answers.ts, applied by the live store and
 * useWorkspace), so an entry in flight reads as answered everywhere the moment Send, Done, a lettered tap, Copy or Put
 * in chat is pressed. A reply confirms it (kept overlaid until the client's copy shows it, so nothing flickers back); a
 * failure keeps the pick, the words and the reason, so the question is open again with "Not sent · Retry"; the
 * server's copy settles it (recorded, or answered or withdrawn elsewhere: `settlePendingAnswers`).
 *
 * Web and desktop keep entries in localStorage, so a reload in the middle of a send loses nothing. Phones (React
 * Native, no localStorage) keep them in memory for the session.
 */
/**
 * `images`: how many pasted images went with it. The images themselves are kept in memory (client/unsent-images.ts,
 * too large for localStorage) under `answerImagesKey`; after a reload only the count is left, and the reason says so.
 */
export type PendingAnswer = { choice: string; words?: string; at: number; error?: string; images?: number; action?: AnswerHow;
  /** The server replied: it has the answer. Kept (still overlaid) only until the client's copy shows it, so nothing flickers back. */
  confirmed?: boolean };
/** How long a confirmed answer is overlaid at most: the worker pushes its copy within moments; this only bounds a missed push. */
export const CONFIRMED_KEEP_MS = 30_000;

/**
 * A reload in the middle of a send (answering-is-optimistic): the answer stays in flight, hidden like any other, until
 * the server's copy shows it recorded (`settlePendingAnswers`) or this long has passed, then it comes back as not sent.
 * The worker records an answer before it replies (invariant 36), so a send that reached it shows within a list read.
 */
export const RELOAD_GRACE_MS = 20_000;
export const RELOADED = "Follow-up was reloaded before Paseo confirmed it";

const KEY = "follow-up:pending-answers";
const DAY_MS = 24 * 3_600_000;
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const storage = (): Store | null => { try { const s = (globalThis as { localStorage?: Store }).localStorage; return typeof s?.getItem === "function" ? s : null; } catch { return null; } };

let entries: Record<string, PendingAnswer> = (() => {
  try {
    const raw = storage()?.getItem(KEY); const parsed = raw ? JSON.parse(raw) as Record<string, PendingAnswer> : {};
    // A reload mid-send: an entry without a reply stays in flight for RELOAD_GRACE_MS (expireReloaded), then not sent.
    const now = Date.now();
    return restore(parsed, now);
  } catch { return {}; }
})();

/**
 * Entries read back after a reload. One still in flight stays in flight (hidden) while it is younger than
 * RELOAD_GRACE_MS; an older one, or one that failed, is not sent. Images they carried are gone (never silently).
 */
export function restore(parsed: Record<string, PendingAnswer>, now: number): Record<string, PendingAnswer> {
  return Object.fromEntries(Object.entries(parsed).filter(([, p]) => p && typeof p.choice === "string" && now - p.at < DAY_MS)
    // A confirmed answer is the server's: nothing to keep across a reload.
    .filter(([, p]) => !p.confirmed)
    .map(([k, p]) => {
      if (!p.error && now - p.at < RELOAD_GRACE_MS) return [k, p];
      return [k, unsentAfterReload(p, p.error ?? RELOADED)];
    }));
}
function unsentAfterReload(p: PendingAnswer, why: string): PendingAnswer {
  if (!p.images) return { ...p, error: why };
  const { images: n, ...rest } = p;
  return { ...rest, error: `${why.replace(/\.$/, "")}. ${n === 1 ? "Its image wasn't" : `Its ${n} images weren't`} kept; paste ${n === 1 ? "it" : "them"} again.` };
}
const listeners = new Set<() => void>();
const key = (workspaceId: string, questionId: string) => `${workspaceId}/${questionId}`;
function commit(next: Record<string, PendingAnswer>) {
  entries = next;
  try { storage()?.setItem(KEY, JSON.stringify(entries)); } catch { /* Memory still holds it. */ }
  for (const l of listeners) l();
}

export const pendingAnswer = (workspaceId: string, questionId: string): PendingAnswer | undefined => entries[key(workspaceId, questionId)];
/** Where the unsent answer's images are kept (client/unsent-images.ts), and where QuestionBody's model reads them back. */
export const answerImagesKey = (workspaceId: string, questionId: string) => `answer:${key(workspaceId, questionId)}`;
export function setPendingAnswer(workspaceId: string, questionId: string, answer: { choice: string; words?: string; images?: readonly ImageUpload[]; action?: AnswerHow }) {
  keepUnsent(answerImagesKey(workspaceId, questionId), answer.images);
  commit({ ...entries, [key(workspaceId, questionId)]: { choice: answer.choice, words: answer.words, at: Date.now(), ...(answer.images?.length ? { images: answer.images.length } : {}), ...(answer.action && answer.action !== "send" ? { action: answer.action } : {}) } });
}
/**
 * The server replied with the answer recorded. The entry stays overlaid until the client's copy shows it
 * (settlePendingAnswers), so the question never flickers back open between the reply and the next push; its images
 * are dropped now (the server has them). Bounded by CONFIRMED_KEEP_MS in case no copy arrives.
 */
export function confirmPendingAnswer(workspaceId: string, questionId: string) {
  dropUnsent(answerImagesKey(workspaceId, questionId));
  const k = key(workspaceId, questionId); const p = entries[k]; if (!p || p.error) return;
  const next = { ...p, confirmed: true };
  commit({ ...entries, [k]: next });
  const t = setTimeout(() => { if (entries[k] === next) { const { [k]: _, ...rest } = entries; commit(rest); } }, CONFIRMED_KEEP_MS) as { unref?: () => void }; t.unref?.();
}
/** The toast's Retry: the same answer goes again, so it is in flight (hidden) again until the server replies. */
export function retryPendingAnswer(workspaceId: string, questionId: string) {
  const k = key(workspaceId, questionId); const p = entries[k]; if (!p?.error) return;
  const { error: _, ...rest } = p; commit({ ...entries, [k]: { ...rest, at: Date.now() } });
}
/** The server's copy has these answers (or answered or closed the question elsewhere): nothing is left to keep. */
export function settlePendingAnswers(keys: readonly string[]) {
  const gone = keys.filter(k => k in entries); if (!gone.length) return;
  for (const k of gone) dropUnsent(`answer:${k}`);
  commit(Object.fromEntries(Object.entries(entries).filter(([k]) => !gone.includes(k))));
}
/** The entries a reload left in flight that never showed up in the server's copy come back as not sent. */
export function expireReloaded(now = Date.now()) {
  const late = Object.entries(entries).filter(([, p]) => !p.error && !p.confirmed && !inFlightHere.has(p) && now - p.at >= RELOAD_GRACE_MS);
  if (late.length) commit({ ...entries, ...Object.fromEntries(late.map(([k, p]) => [k, unsentAfterReload(p, RELOADED)])) });
}
/** Entries this page sent (their RPC is still running here); only the ones a reload carried over can expire. */
const inFlightHere = new WeakSet<PendingAnswer>();
export function markSentHere(workspaceId: string, questionId: string) { const p = entries[key(workspaceId, questionId)]; if (p) inFlightHere.add(p); }
export function clearPendingAnswer(workspaceId: string, questionId: string) {
  dropUnsent(answerImagesKey(workspaceId, questionId));
  const k = key(workspaceId, questionId); if (!(k in entries)) return;
  const { [k]: _, ...rest } = entries; commit(rest);
}
export function failPendingAnswer(workspaceId: string, questionId: string, error: string) {
  // One the server already confirmed stays (a later answer in the same batch failing doesn't undo this one).
  const k = key(workspaceId, questionId); const p = entries[k]; if (!p || p.confirmed) return;
  commit({ ...entries, [k]: { ...p, error } });
}

/** The question's unsent answer, if any; re-renders when it changes. */
export function usePendingAnswer(workspaceId: string, questionId: string): PendingAnswer | undefined {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => entries[key(workspaceId, questionId)], () => undefined);
}
export function usePendingAnswers(): Record<string, PendingAnswer> {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, () => entries, () => entries);
}
export const pendingKey = key;
/** Every entry, for the overlay (shared/optimistic-answers.ts withPendingAnswers). */
export const pendingAnswers = () => entries;
export function subscribePendingAnswers(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
// A page loaded with answers a reload left in flight checks them once their grace is over.
if (Object.values(entries).some(p => !p.error)) { const t = setTimeout(() => expireReloaded(), RELOAD_GRACE_MS + 50) as { unref?: () => void }; t.unref?.(); }
