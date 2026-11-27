import { answerStatus, type Question } from "./questions";

/**
 * History lifecycle, shared by wire bounds and their readers. A closed record is terminal even when an old
 * task still points at it. A delivered answer kept as a live task's context remains available until that task ends.
 * This is separate from workspace completion: a closed PR may still need a disposition or deployment evidence.
 */
export const finishedPr = (p: { snapshot?: { state: string } | null }): boolean => p.snapshot?.state === "MERGED" || p.snapshot?.state === "CLOSED";
export const finishedTask = (o: { status: string }): boolean => o.status === "done" || o.status === "waived";
export function finishedQuestion(q: Pick<Question, "id" | "answer" | "closed">, covers: ReadonlySet<string> = new Set()): boolean {
  if (q.closed) return true;
  if (covers.has(q.id)) return false;
  return !!answerStatus(q)?.delivered || q.answer?.delivery.state === "signed-off";
}
/** Cancelled-before-send and superseded batches need no settlement timestamp to be terminal. */
export const finishedBatch = (b: { settledAt: string | null; state: string; movedOn?: unknown }): boolean =>
  !!b.movedOn || b.state === "completed" || b.state === "cancelled" || b.state === "blocked" && !!b.settledAt;
export const finishedPrAction = (a: { state: string }): boolean => a.state !== "sending";
