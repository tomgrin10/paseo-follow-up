// Invariant 141, one-home-model-per-change (client/home-data.ts sharedHome). 2026-11-27, the broad perf check on the
// live-sized seed: Home, Catch up, the sidebar view and the sidebar item's badge each built Home's whole model
// (`buildHome`, 210-480 ms a run on a phone at 6x CPU), so a feed push rebuilt it once per mounted consumer, the badge
// included, on screens that weren't Home. Every consumer now gets one model per store change.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { workspace } from "./fixtures";
import { listEntry } from "../shared/list";

const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { useArranged, useHomeModel, homeBuilds, arrangeBuilds } = await import("../client/home-data");
const { DEFAULT_HOME_VIEW } = await import("../shared/home-arrange");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A store the way the client's are: subscribe, version, and its values. */
function store<T extends object>(values: T) {
  const listeners = new Set<() => void>(); let version = 0;
  return Object.assign(values, { subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, version: () => version, bump() { version++; for (const l of listeners) l(); } });
}

test("one-home-model-per-change: four mounted consumers share one model, built once per store change", async () => {
  let tracked = [listEntry(workspace({ id: "w1", title: "One" }))];
  const live = store({ all: () => tracked, get: (id: string) => tracked.find(w => w.id === id) });
  const inbox = store({ rows: () => [] });
  const paseo = store({ all: () => [], get: () => undefined });
  const priorities: never[] = []; const compass = {}; const context = {}; const usage = { resources: null };
  const extras = store({ view: () => DEFAULT_HOME_VIEW, sort: () => "attention", priorities: () => priorities, overseer: () => null, usage: () => usage, queue: () => ({ needs: [] }), compass: () => compass, context: () => context });
  const sources = { inbox, live, paseo, extras } as never;
  const seen: unknown[][] = [[], [], [], []];
  // Home, Catch up, the sidebar view and the sidebar item's badge, each its own component, as in the app.
  const arranged: unknown[][] = [[], []];
  // Home and the sidebar view also arrange it (useArranged); Catch up and the badge read the model alone.
  const Consumer = ({ i }: { i: number }) => { const model = useHomeModel(sources); seen[i]!.push(model); if (i < 2) arranged[i]!.push(useArranged(sources, model).arranged); return null; };
  let r!: { unmount(): void };
  const before = homeBuilds(); const arrangedBefore = arrangeBuilds();
  await act(() => { r = create(createElement("div", null, ...[0, 1, 2, 3].map(i => createElement(Consumer, { i, key: i })))); });
  assert.equal(homeBuilds() - before, 1, "first render: one build for four consumers");
  const first = seen.map(s => s.at(-1));
  assert.ok(first.every(m => m === first[0]), "every consumer draws the same model object");
  assert.equal(arrangeBuilds() - arrangedBefore, 1, "Home and the sidebar view arrange it once"); assert.equal(arranged[0]!.at(-1), arranged[1]!.at(-1));
  tracked = [listEntry(workspace({ id: "w1", title: "One, renamed" }))];
  await act(() => { live.bump(); });
  assert.equal(homeBuilds() - before, 2, "a feed push: one more build, not four");
  const next = seen.map(s => s.at(-1));
  assert.ok(next.every(m => m === next[0]) && next[0] !== first[0]);
  assert.equal(arrangeBuilds() - arrangedBefore, 2, "and once more after the push");
  await act(() => { r.unmount(); });
});

test("one-home-model-per-change: only home-data.ts builds Home's model on the client", () => {
  const dir = join(import.meta.dirname, "..", "client");
  const builders = readdirSync(dir).filter(f => /\.tsx?$/.test(f) && f !== "home-data.ts").filter(f => /\b(buildHome|arrangeHome)\s*\(/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(builders, [], "a surface that needs Home's model or its arrangement reads useHomeModel / useArranged (one shared build), never buildHome or arrangeHome itself");
});
