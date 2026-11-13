import { downstack, isGithubFlow, type ActionPlan } from "./pr-actions";
import type { Pr, Workspace } from "./model";

/**
 * a-click-on-merge-merges (2026-11-13): Merge on a Needs-you row opened the PR sheet, which ran a read-only check and
 * asked "Merge this PR?" with a second Merge #N: two clicks for one decision. A Merge button now names everything its
 * click merges before the click (the stack under the PR included), and the click prepares that exact plan, pinned to
 * the heads the button showed, and confirms it at once when nothing blocks it. Agent tools keep their dry run and
 * confirm=true; only the developer's click is one step.
 */

/** What one click on Merge does, known when the button draws. */
export type MergeScope = {
  /** The PRs the click merges, bottom of the stack first; the button's PR last. */
  prs: { key: string; number: number; head: string }[];
  /** GitHub's merge queue: the click adds the bottom PR, and the queue merges it; the rest follow after it lands. */
  queue: boolean;
  /** The button: "Merge #1630", "Merge 3 PRs", "Add #1628 to merge queue". */
  label: string;
  /** A screen reader's name for the button, with the order. */
  a11y: string;
  /** The row's line for a stack: "Merges #1628, #1629, then #1630". Null for one PR. */
  detail: string | null;
};

const list = (ns: number[]) => ns.length < 2 ? ns.map(n => `#${n}`).join("") : `${ns.slice(0, -1).map(n => `#${n}`).join(", ")}, then #${ns.at(-1)}`;

/**
 * The click's scope from the workspace the button draws from, or null when it can't be known (a parent cycle or a
 * downstack PR outside the inventory: `downstack` throws). Null falls back to the PR sheet's confirm, which explains.
 */
export function mergeScope(w: Pick<Workspace, "prs">, prKey: string): MergeScope | null {
  let prs: Pr[];
  try { prs = downstack(w.prs, prKey); } catch { return null; }
  if (!prs.length || prs.at(-1)!.key !== prKey) return null;
  const numbers = prs.map(p => p.number);
  const queue = isGithubFlow(prs.at(-1)!.snapshot) && !!prs[0].snapshot?.repoMerge?.mergeQueue;
  const rows = prs.map(p => ({ key: p.key, number: p.number, head: p.snapshot?.head ?? "" }));
  const first = numbers[0];
  if (queue) return { prs: rows, queue, label: `Add #${first} to merge queue`,
    a11y: prs.length > 1 ? `Add pull request #${first} to the merge queue, the first of ${list(numbers)}` : `Add pull request #${first} to the merge queue`,
    detail: prs.length > 1 ? `#${first} goes in first; merge ${list(numbers.slice(1))} after it lands` : null };
  return { prs: rows, queue, label: prs.length > 1 ? `Merge ${prs.length} PRs` : `Merge #${first}`,
    a11y: prs.length > 1 ? `Merge ${prs.length} pull requests in order: ${list(numbers)}` : `Merge pull request #${first}`,
    detail: prs.length > 1 ? `Merges ${list(numbers)}` : null };
}

/** Why a prepared plan isn't the one the button named: blockers, or a different set of PRs or heads. Empty: confirm. */
export function planBlockers(scope: MergeScope, plan: Pick<ActionPlan, "prs" | "blockers">): string[] {
  const out = [...plan.blockers];
  for (const p of plan.prs) for (const b of p.blockers) out.push(plan.prs.length > 1 ? `#${p.number}: ${b}` : b);
  const named = scope.prs.map(p => p.key).join(" "), planned = plan.prs.map(p => p.key).join(" ");
  if (named !== planned) out.push(`The stack changed since you saw it: it now merges ${list(plan.prs.map(p => p.number))}`);
  else for (const [i, p] of plan.prs.entries()) if (scope.prs[i].head && p.head !== scope.prs[i].head) out.push(`#${p.number} has new commits since you saw it`);
  return out;
}

export type MergeClickResult =
  | { state: "submitted" | "uncertain"; result: string }
  | { state: "blocked"; blockers: string[] }
  | { state: "failed"; result: string };

/**
 * One click: prepare a fresh plan, check it is what the button showed (same PRs, same heads), then confirm it at once when it is exactly the
 * click's scope with no blockers. A blocker merges nothing and comes back for the row to show.
 */
export async function mergeClick(io: {
  prepare: (prKey: string) => Promise<ActionPlan>;
  confirm: (input: { planId: string; scope: "target" | "downstack" }) => Promise<{ state: "submitted" | "failed" | "uncertain"; result: string }>;
}, prKey: string, scope: MergeScope): Promise<MergeClickResult> {
  // The plan carries each PR's head; the server pins it from prepare to confirm (PrActions.execute re-checks it), and
  // planBlockers refuses a plan whose heads aren't the ones the button showed.
  const plan = await io.prepare(prKey);
  const blockers = planBlockers(scope, plan);
  if (blockers.length) return { state: "blocked", blockers };
  const reply = await io.confirm({ planId: plan.id, scope: plan.prs.length > 1 ? "downstack" : "target" });
  return reply.state === "failed" ? { state: "failed", result: reply.result } : { state: reply.state, result: reply.result };
}
