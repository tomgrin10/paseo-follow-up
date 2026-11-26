// Your questions (docs/needs-you.md#your-questions): what the developer asked an agent, kept 30 days with what came of
// it. One request type with Catch up's More context (`contextRequestSchema`, shared/catch-up.ts): a More context ask is
// a question about a card, a free question has `cardKey: null`. Pure, so the worker, the client and the tests agree.
import { workItems } from "./message-sender";
import { CONTEXT_ANSWER_MAX, CONTEXT_VERSION, contextFileSchema, plainAnswer, type ContextFile, type ContextRequest } from "./catch-up";

/** What the developer (or an agent, with `question_action`) can do with a question. */
export const QUESTION_ACTIONS = ["done", "reply", "task", "withdraw"] as const;
export type QuestionAction = typeof QUESTION_ACTIONS[number];

/** The tool an asked agent replies with (native tools carry the follow_ prefix; the stdio bridge doesn't). */
const REPLY_TOOL = "context_reply";
/** The first words of a free question's message: the chat's renderer and the capture both find it by them. */
export const QUESTION_PREFIX = "Your question";

/** Settled with something to read (an answer, "answered in its chat", a failure), and the developer hasn't yet. */
export const unreadAnswer = (r: Pick<ContextRequest, "state" | "readAt">) => (r.state === "answered" || r.state === "chat" || r.state === "failed") && !r.readAt;
export const askingNow = (r: Pick<ContextRequest, "state">) => r.state === "asking";
/** How a question ended, in a word, for the history list and `context_requests`. */
export function questionOutcome(r: Pick<ContextRequest, "state" | "answer" | "done" | "task">): string {
  if (r.task) return "Made a task";
  if (r.state === "asking") return "Asking";
  if (r.state === "withdrawn") return "Withdrawn";
  if (r.state === "failed") return "Couldn't ask";
  const how = r.state === "chat" ? r.answer ? "Answered · from its chat" : "Answered in its chat" : "Answered";
  return r.done ? `${how} · done` : how;
}

/**
 * v1 → v2, on load. v1 had only More context asks, each kept a day on its card: the settled ones become history rows
 * the developer has already seen (they were on the card), so the move never floods Needs you. An open one stays open.
 */
export function migrateContext(raw: unknown): { file: ContextFile; migrated: boolean } {
  const file = contextFileSchema.parse(raw);
  if (file.version === CONTEXT_VERSION) return { file, migrated: false };
  return { file: { version: CONTEXT_VERSION, requests: file.requests.map(r => r.state === "asking" || r.readAt ? r : { ...r, readAt: r.settledAt ?? r.askedAt }) }, migrated: true };
}

/**
 * Turn-end capture: the agent's answer when it ended its turn without `context_reply`. The last assistant message after
 * the question's own message in the turn's items (the items the worker already read for the turn end; no read of its
 * own). Follow-up's hook bookkeeping (workItems) never counts. Null when the question isn't in the items or nothing
 * was said after it: the question then reads "answered in its chat" with Open chat.
 */
export function capturedAnswer(items: readonly unknown[] | null, requestId: string): string | null {
  if (!items) return null;
  const work = workItems(items) as { type?: unknown; text?: unknown }[];
  const own = mentionsId(requestId);
  const at = work.findLastIndex(i => i?.type === "user_message" && typeof i.text === "string" && own.test(i.text));
  if (at < 0) return null;
  const reply = work.slice(at + 1).findLast(i => i?.type === "assistant_message" && typeof i.text === "string" && i.text.trim());
  const text = typeof reply?.text === "string" ? plainAnswer(reply.text).slice(0, CONTEXT_ANSWER_MAX) : "";
  return text || null;
}

/**
 * The id as a whole word: a short id (`ctx-3f9a2b1c`) never matches inside an older, longer one (`ctx-3f9a2b1c-…`).
 */
const mentionsId = (id: string) => new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);

/** A new request id: short enough to read in a chat (`ctx-` and 8 hex), never one the file already has. */
export function newQuestionId(taken: (id: string) => boolean, random: () => string): string {
  for (;;) { const id = `ctx-${random()}`; if (!taken(id)) return id; }
}

/**
 * The message a free question (the field, `/ask`, an agent's ask, a Reply) puts in the asked agent's chat: human-first
 * and short, since the developer reads it in that chat too. One line with the id and the tool, then the question.
 * How to answer (plain words, short, a question is not a task) lives in `context_reply`'s description, not here.
 */
export function agentQuestionPrompt(r: Pick<ContextRequest, "id" | "ask" | "by" | "parentId">, parent?: Pick<ContextRequest, "ask" | "answer"> | null): string {
  const from = r.by === "developer" ? "" : ` · asked by agent ${r.by.replace(/^agent:/, "")} for the developer`;
  return [
    `${QUESTION_PREFIX} (${r.id})${from} · answer with ${REPLY_TOOL}:`,
    r.ask,
    ...(parent ? [`(Following up "${questionLine(parent.ask, 160)}"${parent.answer ? `, you answered "${questionLine(parent.answer, 240)}"` : ""}.)`] : []),
  ].join("\n");
}

/** A question as one line ("Why does the retry use a fixed gap?"): its first line, trimmed for a row. */
export const questionLine = (ask: string, max = 120): string => { const l = ask.split("\n")[0].trim(); return l.length > max ? `${l.slice(0, max - 1)}…` : l; };

/** Make a task: the obligation's title and its note (the Q&A, so whoever works it has both). */
export function questionTask(r: Pick<ContextRequest, "ask" | "answer">): { title: string; note: string } {
  return { title: questionLine(r.ask, 160), note: [`Q: ${r.ask}`, `A: ${r.answer ?? "(answered in its chat)"}`].join("\n").slice(0, 2000) };
}

/** The per-workspace view Home, the panel and Catch up read: unread answers and questions still asking, newest first. */
export type WorkspaceQuestions = { unread: ContextRequest[]; asking: ContextRequest[] };
export function questionsByWorkspace(requests: readonly ContextRequest[]): Map<string, WorkspaceQuestions> {
  const out = new Map<string, WorkspaceQuestions>();
  for (let i = requests.length - 1; i >= 0; i--) {
    const r = requests[i];
    if (!r.workspaceId) continue;
    const unread = unreadAnswer(r), asking = askingNow(r);
    if (!unread && !asking) continue;
    const q = out.get(r.workspaceId) ?? { unread: [], asking: [] };
    (unread ? q.unread : q.asking).push(r);
    out.set(r.workspaceId, q);
  }
  return out;
}

/** The card header's counts ("1 answer · 1 asking"). */
export function questionCounts(q: WorkspaceQuestions | undefined): string {
  if (!q) return "";
  const parts = [q.unread.length ? `${q.unread.length} answer${q.unread.length === 1 ? "" : "s"}` : "", q.asking.length ? `${q.asking.length} asking` : ""];
  return parts.filter(Boolean).join(" · ");
}

/** History search: question and answer text, any word order, case-insensitive. */
export function matchesQuestion(r: Pick<ContextRequest, "ask" | "answer" | "card">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${r.ask}\n${r.answer ?? ""}\n${r.card}`.toLowerCase();
  return words.every(w => hay.includes(w));
}
export const HISTORY_FILTERS = ["all", "open", "tasks"] as const;
export type HistoryFilter = typeof HISTORY_FILTERS[number];
/** The history list: newest first, filtered (Open: asking or unread; Tasks: made a task) and searched. */
export function questionHistory(requests: readonly ContextRequest[], o: { workspaceId?: string | null; filter?: HistoryFilter; query?: string } = {}): ContextRequest[] {
  return requests.filter(r => (o.workspaceId === undefined || r.workspaceId === o.workspaceId)
    && (o.filter === "open" ? askingNow(r) || unreadAnswer(r) : o.filter === "tasks" ? !!r.task : true)
    && (!o.query || matchesQuestion(r, o.query))).reverse();
}

/** Where a question came from, for its history row ("from Catch up on Q12", "with /ask"). Empty for the field. */
export function questionSource(r: Pick<ContextRequest, "via" | "card" | "by" | "parentId">): string {
  if (r.parentId) return "a reply";
  if (r.via === "more") return r.card ? `from Catch up on ${r.card.split(" · ")[0]}` : "from Catch up";
  if (r.via === "slash") return "with /ask";
  if (r.via === "tool" || r.by.startsWith("agent:")) return "asked by an agent";
  return "";
}
