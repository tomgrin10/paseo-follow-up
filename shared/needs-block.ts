import type { NeedItem } from "./attention";
import type { Question } from "./questions";

/**
 * What one surface's Needs you block shows (the workspace panel, Home's detail pane): one "Needs you · N" frame whose
 * first items are the asks, then one row per other decision. An open question is canonical and renders exactly once:
 *
 *  - the agent's open brief that points at questions (`questionIds`, set by needs_you) becomes the first of those
 *    questions' cards, carrying the brief's context. The brief's own card is never drawn beside it;
 *  - a brief that points at no open question keeps its own card, unless every question it points at is settled (it
 *    is resolving);
 *  - every other open question gets the same card. The first question card is open, the rest are collapsed headers
 *    that expand in place;
 *  - the rows below drop every question, so nothing asks twice. Status invariant an-open-question-renders-once-per-surface.
 *
 * The answer path is the question's own (follow.answer-question), whichever surface it is answered from, so the
 * panel, Home, the pill, the chat card and the brief all clear together.
 */
export type AskCard =
  | { kind: "brief" }
  | { kind: "question"; questionId: string; /** This card carries the open brief's context. */ brief: boolean; expanded: boolean };

export type NeedsBlock = { cards: AskCard[]; rows: NeedItem[]; count: number };

/** `items`: needsYou(w) (or the snooze-aware activeNeeds). `brief`: the agent's open brief this surface would show, or null. */
export function needsYouBlock(items: readonly NeedItem[], brief: { questionIds: readonly string[] } | null, questions: readonly Pick<Question, "id" | "answer" | "closed">[] = []): NeedsBlock {
  const open = items.filter((i): i is Extract<NeedItem, { kind: "question" }> => i.kind === "question").map(i => i.questionId);
  const linked = brief ? brief.questionIds.filter((id, i, all) => open.includes(id) && all.indexOf(id) === i) : [];
  // Every question the brief points at is answered or withdrawn: the brief is resolving (briefQuestionsEvent), so the
  // answered question never comes back as the brief's own card while the server catches up.
  const resolving = !!brief?.questionIds.length && brief.questionIds.every(id => questions.some(q => q.id === id && (q.answer || q.closed)));
  const cards: AskCard[] = brief && !linked.length && !resolving ? [{ kind: "brief" }] : [];
  const order = [...linked, ...open.filter(id => !linked.includes(id))];
  order.forEach((questionId, i) => cards.push({ kind: "question", questionId, brief: questionId === linked[0], expanded: i === 0 }));
  const rows = items.filter(i => i.kind !== "question");
  return { cards, rows, count: cards.length + rows.length };
}

/**
 * The invariant's check: every open question appears once among the cards and never as a row, for any brief this
 * surface could show. Null when it holds.
 */
export function onceViolation(items: readonly NeedItem[], briefs: readonly ({ questionIds: readonly string[] } | null)[]): string | null {
  const open = items.filter(i => i.kind === "question").map(i => (i as Extract<NeedItem, { kind: "question" }>).questionId);
  for (const brief of briefs) {
    const block = needsYouBlock(items, brief);
    const shown = block.cards.flatMap(c => c.kind === "question" ? [c.questionId] : []);
    const label = brief ? `brief → [${brief.questionIds.join(", ")}]` : "no brief";
    for (const id of open) {
      const n = shown.filter(x => x === id).length + block.rows.filter(r => "questionId" in r && r.kind === "question" && r.questionId === id).length;
      if (n !== 1) return `${id} renders ${n} times (${label})`;
    }
    if (brief && block.cards.some(c => c.kind === "brief") && brief.questionIds.some(id => open.includes(id))) return `the brief's own card shows beside its open question (${label})`;
    if (block.cards.filter(c => c.kind === "question" && c.expanded).length > 1) return `more than one question card is open (${label})`;
  }
  return null;
}
