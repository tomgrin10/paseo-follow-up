import { HOOK_TEXT_PREFIXES } from "./message-sender";
import type { Workspace } from "./model";
import { duplicateOpenQuestions } from "./questions";
import { shouldReopen, type Brief } from "./brief";

/**
 * Status invariants: what must hold for any workspace, whatever path changed it. Pure, no IO, and never throwing:
 * `check` returns null when the invariant holds, else a short detail. Each id names the bug class it guards
 * (tests/status-invariants.test.ts runs every one over a grid of workspaces plus one fixture per reported bug).
 */
export type Invariant = { id: string; why: string; check(w: Workspace, now: number): string | null };

export const INVARIANTS: Invariant[] = [
  {
    id: "no-duplicate-open-question",
    why: "Needs-you never shows two cards for the same open question: every path that creates a question links to a matching open one instead (shared/questions.ts findOpenMatch).",
    check(w) {
      const dupes = duplicateOpenQuestions(w.questions ?? []);
      return dupes.length ? dupes.map(d => `${d.duplicate.id} repeats ${d.of.id}`).join(", ") : null;
    },
  },
];

export function violations(w: Workspace, now: number): { id: string; detail: string }[] {
  const out: { id: string; detail: string }[] = [];
  for (const inv of INVARIANTS) {
    let detail: string | null;
    try { detail = inv.check(w, now); } catch (error) { detail = `check threw: ${error instanceof Error ? error.message : String(error)}`; }
    if (detail) out.push({ id: inv.id, detail });
  }
  return out;
}

/**
 * Needs-you cards (briefs live in the inbox store, not the workspace). An agent's current card follows its linked
 * questions: while one is open on the server, only the developer closes the card. `brief-follows-questions`.
 */
export function briefViolations(current: Pick<Brief, "id" | "state" | "outcome" | "questionIds">, openQuestionIds: ReadonlySet<string>): { id: string; detail: string }[] {
  return shouldReopen(current, openQuestionIds) ? [{ id: "brief-follows-questions", detail: `${current.id} is ${current.state} while ${current.questionIds.filter(id => openQuestionIds.has(id)).join(", ")} ${current.questionIds.filter(id => openQuestionIds.has(id)).length === 1 ? "is" : "are"} open` }] : [];
}

/**
 * Conversation surfaces (Recent steps, the Overseer's digest and handoff, Summary inputs): what Follow-up shows or
 * feeds a model from a conversation never carries Paseo's raw envelope. Its sender is classified first
 * (shared/message-sender.ts), so another agent's words read "From <agent>" and never as the developer's.
 * `no-raw-paseo-envelope`; the attribution half, `only-developer-is-developer`, is driven per call site in
 * tests/message-sender.test.ts.
 */
export function senderViolations(texts: readonly string[]): { id: string; detail: string }[] {
  return texts.filter(t => typeof t === "string" && t.includes("<paseo-system")).map(t => ({ id: "no-raw-paseo-envelope", detail: t.slice(0, 80) }));
}

/**
 * `no-follow-up-text-as-work`: Summary inputs, the Finished reason and Recent steps never carry Follow-up's own words as
 * the agent's or the developer's work: its hook feedback (the Stop-hook bookkeeping nudge and the other hook texts),
 * batch headers or recovery prompts. A Recent-steps row labelled as Follow-up's own is exempt (pass only unlabelled text).
 */
export function followUpTextViolations(texts: readonly (string | null | undefined)[]): { id: string; detail: string }[] {
  const own = (t: string) => HOOK_TEXT_PREFIXES.some(p => t.includes(p)) || /(?:^|\n|: )(?:Workspace follow-through batch|Follow-through batch|Follow-through recovery) /.test(t);
  return texts.filter((t): t is string => typeof t === "string" && own(t)).map(t => ({ id: "no-follow-up-text-as-work", detail: t.slice(0, 80) }));
}
