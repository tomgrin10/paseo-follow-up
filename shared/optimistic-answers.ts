/**
 * Answering is optimistic (invariant 138, `answering-is-optimistic`). The moment the developer answers a question
 * (Send, Done, a lettered tap, Copy, Put in chat), the client holds the answer as in flight (client/pending-answers.ts)
 * and every surface reads its workspaces through `withPendingAnswers`: the question already carries the answer the
 * server will record (`developerAnswer`, server/questions.ts, the same delivery state), so Needs you, every count,
 * the pill, Catch up and the chat card agree at once, from one rule, and nothing moves when the server's copy lands.
 * A failed send drops the overlay (the entry keeps its error), so the question is open again with what was typed.
 */
import type { Question } from "./questions";

/** What the developer did with the answer: Send (and Done), Copy, or Put in chat. */
export type AnswerHow = "send" | "copy" | "chat";
/** An answer on its way: no error yet. `action` is absent on entries kept before 2.6 (they were all sends). */
export type InFlightAnswer = { choice: string; words?: string; at: number; error?: string; action?: AnswerHow };

type Q = Pick<Question, "id" | "answer" | "closed">;

/** The answer the server records for this action (`developerAnswer`'s delivery states), drawn until it does. */
export function optimisticAnswer(p: InFlightAnswer, to: string | null): NonNullable<Question["answer"]> {
  const at = new Date(p.at).toISOString();
  const how = p.action ?? "send";
  return { choice: p.choice, ...(p.words?.trim() ? { words: p.words.trim() } : {}), at, by: "developer",
    delivery: { state: how === "copy" ? "copied" : how === "chat" ? "in-chat" : "sending", to: how === "chat" ? to : null, messageId: null, at, reason: null } };
}

/** Whether an entry is still on its way (a failed one has its error and shows the question open again). */
export const inFlight = (p: InFlightAnswer | undefined): p is InFlightAnswer => !!p && !p.error;

/**
 * The workspace as the developer's answers make it: every open question with an answer in flight reads as answered.
 * Returns the same object when nothing applies, so caches keyed by identity (ListCache's client twin, memoised
 * selectors) keep working.
 */
export function withPendingAnswers<W extends { id: string; mainAgentId?: string | null; questions: readonly Q[] }>(w: W, pending: Readonly<Record<string, InFlightAnswer>>, key: (workspaceId: string, questionId: string) => string): W {
  if (!w.questions?.length) return w;
  let changed = false;
  const questions = w.questions.map(q => {
    const p = pending[key(w.id, q.id)];
    if (!inFlight(p) || q.closed || (q.answer && !(waitingToSend(q) && (p.action ?? "send") === "send"))) return q;
    changed = true;
    // Send on an answer that was copied or put in chat sends the recorded one: it reads as on its way, as the server records it.
    if (q.answer) return { ...q, answer: { ...q.answer, delivery: { ...q.answer.delivery, state: "sending" as const, at: new Date(p.at).toISOString() } } };
    return { ...q, answer: optimisticAnswer(p, (q as { askedBy?: string | null }).askedBy ?? w.mainAgentId ?? null) };
  });
  return changed ? { ...w, questions } : w;
}

/**
 * Entries the server's copy of a workspace has settled: the question is answered or closed there (this answer landed,
 * or it was answered or withdrawn elsewhere meanwhile). Read from the server's copy, never the overlaid one.
 */
export function settledAnswers(w: { id: string; questions: readonly Q[] }, pending: Readonly<Record<string, InFlightAnswer>>, key: (workspaceId: string, questionId: string) => string): string[] {
  return (w.questions ?? []).filter(q => { const p = pending[key(w.id, q.id)]; return !!p && (!!q.closed || !!q.answer && !((p.action ?? "send") === "send" && waitingToSend(q))); }).map(q => key(w.id, q.id));
}
/** Recorded but not sent: copied, or put in the agent's chat (invariant 20). Send sends it. */
const waitingToSend = (q: Q) => q.answer?.delivery.state === "copied" || q.answer?.delivery.state === "in-chat";

/**
 * An inbox row as the server makes it once every question its open brief points at is answered or closed
 * (`questionsChanged`, server/inbox.ts): the brief resolves. Read against the overlaid workspace, so a row whose ask was
 * a question leaves Needs you with the question, before the worker's next inbox push.
 */
export function withSettledBrief<R extends { brief?: { state: string; questionIds?: string[] } | null }>(row: R, w: { questions: readonly Q[] } | undefined): R {
  const b = row.brief;
  if (!w || b?.state !== "open" || !b.questionIds?.length) return row;
  const settled = b.questionIds.every(id => { const q = w.questions.find(x => x.id === id); return !!q && (!!q.answer || !!q.closed); });
  return settled ? { ...row, brief: { ...b, state: "answered" } } : row;
}
