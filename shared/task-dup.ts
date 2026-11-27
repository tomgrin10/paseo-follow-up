import { finishedTask } from "./finished";
import type { Obligation, Workspace } from "./model";
import { followUpObligations } from "./follow-up";

// a-new-task-is-checked-once. 2026-11-22 live audit: 3-4 true duplicate tasks, and 66 tasks renamed in place (21 three or
// more times). The only place a duplicate is checked is the write that would make it: update_obligation without an id,
// against this workspace's open tasks (p95 7, max 14 live). Token Jaccard on the first 60 characters of each title,
// microseconds each; no scans, no pairwise passes, no model. Renames keep the id, so they never reach this check.

/** Titles compare on their first 60 characters: what an agent names a task by. */
export const DUP_TITLE_CHARS = 60;
/** At or above this a title is close enough to ask "update that one instead?". */
export const DUP_SIMILARITY = 0.5;
/** At most this many candidates in the reply: about 20 tokens each. */
export const DUP_MAX = 3;

const open = (o: Obligation) => !finishedTask(o);
/** Case, spacing and punctuation don't make a different task. The whole title: the exact-title rule compares this. */
export const normTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}#]+/gu, " ").trim();
/** The similarity score reads only the first 60 characters, what an agent names a task by. */
const tokens = (title: string) => new Set(normTitle(title.slice(0, DUP_TITLE_CHARS)).split(" ").filter(Boolean));

export function titleSimilarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** The open task this caller already made with this title: a repeat of the same write, so it updates that task. */
export function sameTask(w: Workspace, title: string, caller: string | undefined): Obligation | undefined {
  if (!caller) return undefined;
  const t = normTitle(title);
  return followUpObligations(w).find(o => open(o) && o.createdBy === caller && normTitle(o.title) === t);
}

/** Open tasks whose title is close to this one, closest first, at most DUP_MAX. */
export function similarOpen(w: Workspace, title: string): { o: Obligation; score: number }[] {
  return followUpObligations(w).filter(open).map(o => ({ o, score: titleSimilarity(title, o.title) }))
    .filter(c => c.score >= DUP_SIMILARITY).sort((a, b) => b.score - a.score).slice(0, DUP_MAX);
}

/** The refusal: one line per candidate, each with the id to update by; the first says what to do. */
export function similarLines(candidates: { o: Obligation }[]): string {
  return candidates.map((c, i) => `Similar open task: ${c.o.id} "${c.o.title.slice(0, DUP_TITLE_CHARS)}" (${c.o.status}).${i === 0 ? " Update it by id, or pass new=true for a separate task." : ""}`).join("\n");
}
