// Invariant 148, typing-never-redraws-unchanged-rows (client/home-list.tsx Row, shared/search.ts sameHit,
// client/home-chrome.tsx useOmnibox). 2026-11-27, the broad perf check on the live-sized seed: typing "ledger" in Home's
// search took 2.0-2.4 s on a phone at 6x CPU (~350 ms a key) and drew 27,700 components for 6 keys. Each key built new
// hit objects and a new pick callback, so the memoised Row drew all ~60 results again, with every chip rail and time
// under it, before the field could show the key. A key now redraws only the rows whose highlight moved, never their
// rail or time, and the results follow the typed query at low priority.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { workspace, pr, snapshot, clock } from "./fixtures";
import { buildHome } from "../shared/home";
import { homeSearchDocs, indexDocs, omniboxResults, rowHit, workspaceProvider, sameHit, type OmniboxItem } from "../shared/search";
import * as React from "react";

const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { update(el: unknown): void; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = join(import.meta.dirname, "..");
type ListModule = { HomeList: (p: Record<string, unknown>) => unknown; rowRenders(): { rows: number; rails: number } };
/** HomeList bundled for Node: React Native's views draw their children, FlatList draws every item. */
async function bundleList(): Promise<ListModule> {
  const dir = join(root, "node_modules", ".cache", "follow-search-rows");
  await mkdir(dir, { recursive: true });
  const stub = join(dir, "stub.cjs");
  // Named exports are listed (esbuild's CommonJS interop copies own keys), read from the client's own imports.
  const names = new Set<string>();
  for (const f of (await readdir(join(root, "client"))).filter(f => /\.tsx?$/.test(f))) {
    const src = await readFile(join(root, "client", f), "utf8");
    for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(react-native|@getpaseo\/plugin\/client(?:\/ui)?)"/g)) for (const n of m[1]!.split(",")) { const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]; if (name) names.add(name); }
  }
  // The bundle shares the test's React (one copy, so hooks work): the stub reads it from a global, not a require.
  (globalThis as { __searchRowsReact?: unknown }).__searchRowsReact = React;
  await writeFile(stub, `const R = globalThis.__searchRowsReact;
const pass = p => R.createElement(R.Fragment, null, typeof p.children === "function" ? p.children({}) : p.children ?? null);
// A component draws its children; anything else (Easing.bezier, Animated.Value…) is an inert value of any shape.
const statics = new Set(["prototype", "$$typeof", "defaultProps", "displayName", "contextType", "contextTypes", "childContextTypes", "getDerivedStateFromProps", "propTypes", "compare", "render", "type", "then"]);
const deep = new Proxy(function Stub() {}, { get: (_t, k) => typeof k === "symbol" || statics.has(k) ? undefined : deep, construct: () => deep,
  apply: (_t, _self, args) => args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) && args.length <= 2 ? pass(args[0]) : deep });
const FlatList = p => R.createElement(R.Fragment, null, ...(p.data ?? []).map((item, index) => R.createElement(R.Fragment, { key: p.keyExtractor(item, index) }, p.renderItem({ item, index }))));
const special = { FlatList, Platform: { OS: "web", select: o => o.web ?? o.default }, StyleSheet: { create: s => s, hairlineWidth: 1 }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
for (const name of ${JSON.stringify([...names])}) exports[name] = special[name] ?? deep;`);
  const out = join(dir, "list.mjs");
  await build({
    stdin: { contents: `export { HomeList, rowRenders } from "./client/home-list";`, resolveDir: root, loader: "ts" },
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic",
    alias: { "react-native": stub, "@getpaseo/plugin/client/ui": stub, "@getpaseo/plugin/client": stub },
    external: ["react", "react/*", "zod", "@tanstack/*", "@getpaseo/plugin", "lucide-react-native"],
  });
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`) as Promise<ListModule>;
}

// Twelve followed workspaces, each with an open PR so its row carries a chip rail: four Ledger ones, the rest not.
const titles = ["Ledger sync", "Ledger export", "Fix ledger totals", "Ledger import", "Webhook retries", "Billing page", "Search index", "Login flow", "Audit log", "Rate limits", "Docs site", "Release notes"];
const tracked = titles.map((title, i) => workspace({ id: `w${i}`, title, prs: [pr({ key: `example/app#${i + 1}`, number: i + 1, snapshot: snapshot({ title: `${title} change` }) })] }));
const model = buildHome({ rows: [], tracked, paseo: [], now: clock });
const index = indexDocs(homeSearchDocs({ model, paseo: [], tracked }));
const resultsFor = (q: string): OmniboxItem[] => omniboxResults([workspaceProvider(index, clock)], q);
const rows = new Map(model.groups.flatMap(g => g.items).map(s => [s.key, s]));
/** What the Row for `key` draws from these results (listEntries' rowHit), null when it isn't among them. */
const hitOf = (items: OmniboxItem[], key: string) => { const i = items.find(x => !x.ask && x.key === key); const row = rows.get(key); return i && !i.ask && i.hit && row ? rowHit(i.hit, row) : null; };

test("typing-never-redraws-unchanged-rows: a key redraws only the rows whose highlight moved, never their rail or time", { timeout: 60_000 }, async () => {
  const { HomeList, rowRenders } = await bundleList();
  const theme = { colors: new Proxy({}, { get: () => "#000" }) };
  // Home's row menu and onSelect are stable (useRowMenu, useCallback); its onResult is new on every render.
  const menu = { build: () => [] }, onSelect = () => undefined;
  const list = (results: OmniboxItem[]) => createElement(HomeList as never, { model, theme, dense: false, touch: false, selectedKey: null, results, activeResult: 0, onResult: () => undefined, menu, onSelect } as never);
  let r!: { update(el: unknown): void; unmount(): void };
  const led = resultsFor("led");
  assert.ok(led.length >= 4, `"led" finds the Ledger rows (${led.length})`);
  await act(() => { r = create(list(led)); });
  const first = rowRenders();
  assert.equal(first.rows, led.length, "each result draws once");
  assert.ok(first.rails >= led.length, "with its chip rail");

  // The same query again (a feed push, or Home re-rendering for anything else): new hit objects, nothing moved.
  await act(() => { r.update(list(resultsFor("led"))); });
  assert.deepEqual(rowRenders(), first, "new hit objects with the same highlights redraw nothing");

  // One more key: search highlights whole words, so "ledg" marks what "led" did and no row draws.
  const ledg = resultsFor("ledg");
  assert.equal(ledg.length, led.length);
  const moved = ledg.filter(i => !i.ask && !sameHit(hitOf(led, i.key), hitOf(ledg, i.key))).length;
  assert.equal(moved, 0, "whole-word highlights: \"ledg\" marks what \"led\" did");
  await act(() => { r.update(list(ledg)); });
  const after = rowRenders();
  assert.equal(after.rows - first.rows, moved, `a key that moves no highlight draws no row`);
  assert.equal(after.rails, first.rails, "a highlight never redraws a row's chip rail");
  // A key that moves a highlight ("ledger e": "export" lights up too) draws that row alone, still without its rail.
  const more = resultsFor("ledger e");
  const changed = more.filter(i => !i.ask && !sameHit(hitOf(ledg, i.key), hitOf(more, i.key))).map(i => i.key);
  assert.deepEqual(changed, ["ws:w1"], "\"ledger e\" leaves Ledger export, its \"export\" now marked too");
  await act(() => { r.update(list(more)); });
  const last = rowRenders();
  assert.equal(last.rows - after.rows, changed.length, "only the rows whose highlight moved");
  assert.equal(last.rails, first.rails + more.filter(i => !hitOf(ledg, i.key)).length, "and no kept row's rail");
  await act(() => { r.unmount(); });
});

test("typing-never-redraws-unchanged-rows: sameHit compares what the row draws", () => {
  const a = hitOf(resultsFor("ledger"), "ws:w1"), b = hitOf(resultsFor("ledger"), "ws:w1");
  assert.ok(a && b && a !== b && sameHit(a, b), "the same query: equal hits, new objects");
  assert.ok(!sameHit(hitOf(resultsFor("ledger e"), "ws:w1"), a), "a match on another word moves the highlight");
  assert.ok(sameHit(null, undefined) && !sameHit(a, null));
});
