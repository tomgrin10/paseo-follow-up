import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mergeClick, mergeScope, planBlockers } from "../shared/merge-click";
import type { ActionPlan } from "../shared/pr-actions";
import type { Pr } from "../shared/model";
import { pr, snapshot, workspace } from "./fixtures";

/**
 * a-click-on-merge-merges (2026-11-13): Merge on a Needs-you row opened the PR sheet, which ran a read-only check and
 * asked "Merge this PR?" with a second Merge #N. One click now prepares the plan and confirms it at once when it holds
 * exactly what the button named, at the heads it showed, with no blockers. Agent tools keep their dry run.
 */
const open = (n: number, parent: number | null, patch: Partial<Pr> = {}) => pr({ key: `example/app#${n}`, number: n, parent: parent ? `example/app#${parent}` : null,
  snapshot: snapshot({ head: `head-${n}`, reviewDecision: "APPROVED", title: `PR ${n}` }), ...patch });
const stack = () => workspace({ prs: [open(1628, null), open(1629, 1628), open(1630, 1629)] });
const planOf = (prs: Pr[], patch: Partial<ActionPlan> = {}, rowBlockers: Record<number, string[]> = {}): ActionPlan => ({
  id: "plan-1", workspaceId: "workspace", target: prs.at(-1)!.key, kind: "merge", expiresAt: "2026-01-01T10:01:00Z", blockers: [],
  prs: prs.map(p => ({ key: p.key, repo: p.repo, number: p.number, title: p.snapshot!.title, head: p.snapshot!.head, parent: p.parent, base: "", trunk: "main", blockers: rowBlockers[p.number] ?? [] })), ...patch });

/** A recording stand-in for the two RPCs. */
function io(plan: ActionPlan) {
  const calls = { prepare: [] as string[], confirm: [] as { planId: string; scope: string }[] };
  return { calls, io: {
    prepare: async (key: string) => { calls.prepare.push(key); return plan; },
    confirm: async (input: { planId: string; scope: "target" | "downstack" }) => { calls.confirm.push(input); return { state: "submitted" as const, result: "Merged #1630." }; },
  } };
}

test("merge-click: one click on a merge row prepares once and confirms once, with no second question", async () => {
  const w = workspace({ prs: [open(1630, null)] });
  const scope = mergeScope(w, "example/app#1630")!;
  assert.deepEqual([scope.label, scope.a11y, scope.detail], ["Merge #1630", "Merge pull request #1630", null]);
  const { calls, io: rpc } = io(planOf(w.prs));
  const result = await mergeClick(rpc, "example/app#1630", scope);
  assert.deepEqual(calls.prepare, ["example/app#1630"]);
  assert.deepEqual(calls.confirm, [{ planId: "plan-1", scope: "target" }]);
  assert.equal(result.state, "submitted");
});

test("merge-click: a stack row names every PR it merges before the click, and the click merges them in order", async () => {
  const w = stack();
  const scope = mergeScope(w, "example/app#1630")!;
  assert.equal(scope.label, "Merge 3 PRs");
  assert.equal(scope.a11y, "Merge 3 pull requests in order: #1628, #1629, then #1630");
  assert.equal(scope.detail, "Merges #1628, #1629, then #1630");
  assert.deepEqual(scope.prs.map(p => p.number), [1628, 1629, 1630]);
  const { calls, io: rpc } = io(planOf(w.prs));
  await mergeClick(rpc, "example/app#1630", scope);
  assert.deepEqual(calls.confirm, [{ planId: "plan-1", scope: "downstack" }], "one confirm, the whole named stack");
  // A merged parent drops out of the scope.
  const partly = workspace({ prs: [open(1628, null, { snapshot: snapshot({ state: "MERGED", head: "head-1628" }) }), open(1629, 1628), open(1630, 1629)] });
  assert.equal(mergeScope(partly, "example/app#1630")!.label, "Merge 2 PRs");
});

test("merge-click: a merge queue names the PR it adds first", () => {
  const queued = (n: number, parent: number | null) => open(n, parent, { snapshot: snapshot({ head: `head-${n}`, prWorkflow: "github", repoMerge: { mergeQueue: true } as never }) });
  const one = mergeScope(workspace({ prs: [queued(1630, null)] }), "example/app#1630")!;
  assert.deepEqual([one.label, one.queue, one.detail], ["Add #1630 to merge queue", true, null]);
  const many = mergeScope(workspace({ prs: [queued(1628, null), queued(1629, 1628), queued(1630, 1629)] }), "example/app#1630")!;
  assert.equal(many.label, "Add #1628 to merge queue");
  assert.equal(many.detail, "#1628 goes in first; merge #1629, then #1630 after it lands");
});

test("merge-click: a blocker at click time merges nothing and says why", async () => {
  const w = stack();
  const scope = mergeScope(w, "example/app#1630")!;
  const cases: [string, ActionPlan, RegExp][] = [
    ["checks went red", planOf(w.prs, {}, { 1629: ["Required checks failed: test"] }), /#1629: Required checks failed: test/],
    ["an action is pending", planOf(w.prs, { blockers: ["Check the previous PR action before sending another."] }), /Check the previous PR action/],
    ["new commits", planOf(w.prs.map(p => p.number === 1630 ? { ...p, snapshot: { ...p.snapshot!, head: "head-new" } } : p)), /#1630 has new commits since you saw it/],
    ["the stack changed", planOf(w.prs.slice(1)), /The stack changed since you saw it: it now merges #1629, then #1630/],
  ];
  for (const [name, plan, why] of cases) {
    const { calls, io: rpc } = io(plan);
    const result = await mergeClick(rpc, "example/app#1630", scope);
    assert.equal(calls.confirm.length, 0, `${name}: nothing merges`);
    assert.equal(result.state, "blocked", name);
    assert.match(result.state === "blocked" ? result.blockers.join(" · ") : "", why, name);
  }
  assert.deepEqual(planBlockers(scope, planOf(w.prs)), [], "the plan the button named confirms");
});

test("merge-click: the scope is unknown only when the stack can't be read, and only then the sheet confirms", () => {
  const cycle = workspace({ prs: [open(1, 2), open(2, 1)] });
  assert.equal(mergeScope(cycle, "example/app#2"), null);
  const outside = workspace({ prs: [open(5, 4)] });
  assert.equal(mergeScope(outside, "example/app#5"), null);
  assert.ok(mergeScope(stack(), "example/app#1629"), "a normal stack is always known");
});

test("merge-click: every Merge button goes through the one click; Merge this PR? is only the unknown-scope fallback", async () => {
  const read = (f: string) => readFile(join(import.meta.dirname, "../client", f), "utf8");
  const ny = await read("needs-you.tsx");
  assert.match(ny, /case "merge": return mergeControl\(item\.prKey, \{ theme, compact, fallback:/, "Needs you (panel, Home, pill) merges in one click");
  assert.doesNotMatch(ny, /case "merge": return actions\.openPr/);
  const controls = await read("pr-controls.tsx");
  assert.match(controls, /const mergeOne = mergeControl\(pr\.key, \{ theme, compact, kind: "primary", disabled, fallback: \(\) => begin\("merge"\) \}\)/, "the PR card's own Merge");
  assert.match(controls, /canMerge && !queued && !recentlySubmitted && !busy && mergeOne\.button \? mergeOne\.button/);
  const brief = await read("brief.tsx");
  assert.match(brief, /const one = m\.kind === "merge" && m\.prKey \? merges\.view\(m\.prKey\) : null;\n\s+if \(one\) one\.run\(\);/, "a brief's merge move");
  const button = await read("merge-button.tsx");
  assert.match(button, /if \(!scope\) return \{ label: null, notice: null, button: fallback \?/, "the sheet only when the scope is unknown");
});

test("merge-click: a PR on a parent that can't merge offers no Merge (never a click the plan refuses)", async () => {
  const { needsYou } = await import("../shared/attention");
  const ready = (n: number, parent: number | null, patch = {}) => open(n, parent, { snapshot: snapshot({ head: `head-${n}`, reviewDecision: "APPROVED", graphiteMergeStatus: "READY_TO_MERGE", ...patch }) });
  const merges = (prs: Pr[]) => needsYou(workspace({ prs }), Date.parse("2026-01-01T10:00:00Z")).filter(i => i.kind === "merge").map(i => i.kind === "merge" && i.number);
  assert.deepEqual(merges([ready(1628, null), ready(1629, 1628), ready(1630, 1629)]), [1628, 1629, 1630]);
  assert.deepEqual(merges([ready(1628, null, { failedChecks: ["test"] }), ready(1629, 1628), ready(1630, 1629)]), [], "#1628 is red: nothing above it offers Merge");
});
