import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import type { Snapshot } from "../shared/model";

register("./support/native/hooks.mjs", import.meta.url);
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { toJSON(): unknown; unmount(): void }; act: (f: () => void) => Promise<void> };
const { PrRow } = await import("../client/stacks");
const { workOf } = await import("../shared/now");
const { compactPrStatus } = await import("../shared/presentation");
const { pr, snapshot, workspace } = await import("./fixtures");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => k in t ? t[k as keyof typeof t] : colors }) as never;
const strings = (node: unknown): string[] => typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? strings((node as { children?: unknown }).children) : [];
const stages: Partial<Snapshot>[] = [
  {}, { conflict: true }, { threads: [{ id: "a", updatedAt: "now" }] },
  { threads: [{ id: "a", updatedAt: "now" }, { id: "b", updatedAt: "now" }] },
  { failedChecks: ["test"] }, { otherFailedChecks: ["preview"] }, { otherFailedChecks: ["preview", "coverage"] },
  { draft: true }, { checksPending: true }, { reviewDecision: "CHANGES_REQUESTED" },
  { reviewDecision: "REVIEW_REQUIRED" }, { reviewDecision: "APPROVED" },
  { prWorkflow: "github", inMergeQueue: true }, { graphiteMergeStatus: "QUEUED_TO_MERGE" },
];

test("every open PR stage and reference agrees between the agent line and the actual PR row", async () => {
  for (const patch of stages) for (const repo of ["example/app", "EXAMPLE/App", "acme/widgets", null]) for (const wide of [false, true]) {
    const p = pr({ snapshot: snapshot(patch) });
    const ref = repo?.toLowerCase() === p.repo.toLowerCase() ? "#1" : "example/app#1";
    const label = patch.inMergeQueue || patch.graphiteMergeStatus ? "Queued to merge" : compactPrStatus(p).label;
    let row!: ReturnType<typeof create>;
    await act(() => { row = create(createElement(PrRow, { pr: p, workspaceRepo: repo, theme, first: true, last: true, onOpen() {}, compact: !wide, wide })); });
    const words = strings(row.toJSON());
    assert.ok(words.includes(label), `${JSON.stringify(patch)}: row says ${label}`);
    assert.ok(words.includes(ref), `${repo}: row names ${ref}`);
    assert.equal(workOf({ ...workspace({ prs: [p] }), repo }, { agentId: "main-agent", role: "main", status: "idle" })?.text, `${ref} · ${label}`, `${JSON.stringify(patch)}: line and row agree`);
    await act(() => row.unmount());
  }
});

test("the status line takes the compact row wording for every known open stage", () => {
  for (const patch of stages) {
    const p = pr({ snapshot: snapshot(patch) });
    const label = patch.inMergeQueue || patch.graphiteMergeStatus ? "Queued to merge" : compactPrStatus(p).label;
    const line = workOf({ ...workspace({ prs: [p] }), repo: "example/app" }, { agentId: "main-agent", role: "main", status: "idle" });
    assert.equal(line?.text, `#1 · ${label}`);
  }
});

test("number search highlights the number after a qualified reference prefix", async () => {
  let row!: ReturnType<typeof create>;
  await act(() => { row = create(createElement(PrRow, { pr: pr(), workspaceRepo: "acme/widgets", theme, first: true, last: true, onOpen() {}, compact: true, hit: { ranges: [[], [[1, 2]]], via: null } })); });
  const words = strings(row.toJSON());
  assert.ok(words.includes("example/app#"));
  assert.ok(words.includes("1"));
  await act(() => row.unmount());
});

test("Home's compact chip uses the same checking word and keeps its short reference", async () => {
  const { prChip } = await import("../shared/home");
  const p = pr({ snapshot: snapshot({ checksPending: true }) });
  const chip = prChip({ ...workspace({ prs: [p] }), repo: "acme/widgets" });
  assert.equal(chip?.label, "#1");
  assert.equal(chip?.checks?.text, compactPrStatus(p).label);
});
