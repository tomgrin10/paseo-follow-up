import type { Workspace } from "./model";
import { duplicateOpenQuestions } from "./questions";

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
