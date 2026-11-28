// Invariant 150, opening-reads-the-workspace-once (client/panel.tsx, client/workspace-data.ts, server/feeds.ts).
// 2026-11-27, the broad perf check on the live-sized seed: opening the workspace panel read the whole workspace
// (`follow.get`, ~375 KB) twice, the second time 1.5 s after asking the worker to check its PRs, whether or not that
// check found anything, and a third time on the first open of a session, when the saved reviewer lists differed from the
// client's and Needs you was recomputed by reading every open workspace again; 4.3 s to paint on a phone at 6x CPU. The check's findings now arrive on their own: a change
// moves the list copy (one re-read), the time it checked rides the feed's read stamps, and new reviewer lists redraw
// from the workspace already held.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { workspace, pr, snapshot, clock } from "./fixtures";
import { listEntry, newerReadStamps } from "../shared/list";
import type { Workspace } from "../shared/model";

const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = join(import.meta.dirname, "..");
type Host = { calls: string[]; answers: Record<string, unknown> };
type ViewModule = { WorkspaceView: (p: Record<string, unknown>) => unknown; useWorkspace: (live: unknown, id: string) => { workspace: Workspace | null } };
/** The panel's own pieces bundled for Node: React Native's views draw their children, and every RPC is counted. */
async function bundle(): Promise<ViewModule> {
  const dir = join(root, "node_modules", ".cache", "follow-panel-open-reads");
  await mkdir(dir, { recursive: true });
  const stub = join(dir, "stub.cjs");
  const names = new Set<string>();
  for (const f of (await readdir(join(root, "client"))).filter(f => /\.tsx?$/.test(f))) {
    const src = await readFile(join(root, "client", f), "utf8");
    for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(react-native|@getpaseo\/plugin\/client(?:\/ui)?)"/g)) for (const n of m[1]!.split(",")) { const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]; if (name) names.add(name); }
  }
  (globalThis as { __panelReadsReact?: unknown }).__panelReadsReact = React;
  await writeFile(stub, `const R = globalThis.__panelReadsReact;
const host = () => globalThis.__panelReadsHost;
const pass = p => R.createElement(R.Fragment, null, typeof p.children === "function" ? p.children({}) : p.children ?? null);
const statics = new Set(["prototype", "$$typeof", "defaultProps", "displayName", "contextType", "contextTypes", "childContextTypes", "getDerivedStateFromProps", "propTypes", "compare", "render", "type", "then"]);
const deep = new Proxy(function Stub() {}, { get: (_t, k) => typeof k === "symbol" || statics.has(k) ? undefined : deep, construct: () => deep,
  apply: (_t, _self, args) => args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) && args.length <= 2 ? pass(args[0]) : deep });
const View = R.forwardRef((p, _ref) => pass(p));
const FlatList = p => R.createElement(R.Fragment, null, ...(p.data ?? []).map((item, index) => R.createElement(R.Fragment, { key: p.keyExtractor ? p.keyExtractor(item, index) : index }, p.renderItem({ item, index }))));
const special = { View, FlatList, Platform: { OS: "web", select: o => o.web ?? o.default }, StyleSheet: { create: s => s, hairlineWidth: 1, flatten: s => s }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
  useRpc: c => async () => { host().calls.push(c.name); const a = host().answers[c.name]; return typeof a === "function" ? a() : a ?? {}; }, useToast: () => ({ show() {}, error() {} }), useTabState: (_k, init) => R.useState(init), useAgent: () => null, useSubscription: () => undefined };
for (const name of ${JSON.stringify([...names])}) exports[name] = special[name] ?? deep;`);
  const out = join(dir, "panel.mjs");
  await build({
    stdin: { contents: `export { WorkspaceView } from "./client/panel"; export { useWorkspace } from "./client/workspace-data";`, resolveDir: root, loader: "ts" },
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic",
    alias: { "react-native": stub, "@getpaseo/plugin/client/ui": stub, "@getpaseo/plugin/client": stub },
    external: ["react", "react/*", "zod", "@tanstack/*", "@getpaseo/plugin", "lucide-react-native"],
  });
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`) as Promise<ViewModule>;
}

const at = (ms: number) => new Date(clock + ms).toISOString();
const full = workspace({ id: "w1", prs: [pr({ snapshot: snapshot({ observedAt: at(0) }) })] });
/** The client's live store as the panel reads it: the list copy, with its read stamps filled in. */
function liveStore(entry: ReturnType<typeof listEntry>) {
  const listeners = new Set<() => void>(); let current = entry;
  return { subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, get: (id: string) => id === current.id ? current : undefined, refresh() {},
    set(next: ReturnType<typeof listEntry>) { current = next; for (const l of listeners) l(); } };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test("opening-reads-the-workspace-once: the open view reads follow.get once, and the check it asks for adds no read", { timeout: 60_000 }, async () => {
  let shown!: () => void; const drawn = new Promise<void>(r => { shown = r; });
  const host: Host = { calls: [], answers: { "follow.get": { workspace: full, error: null }, "follow.refresh": { ok: true }, "follow.browser-status": { ready: false },
    // The saved reviewer lists differ from what this client held (its first open): Needs you is computed again.
    // It answers once the view has drawn (the order that cost a read: there was a workspace to read again).
    "follow.reviewer-settings": () => drawn.then(() => ({ config: { version: 1, repos: { "example/app": [] }, defaults: ["alice"], migratedAt: null }, noReview: ["example/docs"] })) } };
  (globalThis as { __panelReadsHost?: Host }).__panelReadsHost = host;
  const { WorkspaceView, useWorkspace } = await bundle();
  const live = liveStore(listEntry(full));
  const theme = { colors: new Proxy({}, { get: () => "#000" }) };
  const seen: (Workspace | null)[] = [];
  // PanelBody's shape: the view draws what useWorkspace read, so a re-read of the key would reach follow.get.
  const Panel = () => { const { workspace: w } = useWorkspace(live, "w1"); seen.push(w); return w ? createElement(WorkspaceView as never, { theme, layout: { compact: false }, workspace: w, folds: { isOpen: () => false, toggle: () => undefined }, openSettings: () => undefined, openOverview: () => undefined, resize: null, place: "panel" } as never) : null; };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let r!: { unmount(): void };
  await act(() => { r = create(createElement(QueryClientProvider, { client }, createElement(Panel))); });
  for (let i = 0; i < 40 && !seen.at(-1); i++) await act(async () => { await wait(25); });
  shown(); const first = seen.at(-1);
  assert.ok(seen.at(-1), "the view drew the workspace it read");
  assert.equal(host.calls.filter(c => c === "follow.refresh").length, 1, "opening asks the worker to check its PRs");
  assert.ok(host.calls.includes("follow.reviewer-settings"), "and reads the reviewer lists, which changed");
  // Past the old 1.5 s re-read.
  await act(async () => { await wait(1_800); });
  assert.equal(host.calls.filter(c => c === "follow.get").length, 1, `opening read the workspace ${host.calls.filter(c => c === "follow.get").length} times: the check's findings come on the feed, never a second follow.get`);
  assert.ok(first && seen.at(-1) !== first, "the reviewer lists' change redrew the view from the workspace it held");
  // A list push with no newer stamp (a new list object, the same stamps) keeps the workspace object: nothing redraws.
  const held = seen.at(-1);
  await act(async () => { live.set(listEntry(workspace({ ...full }))); await wait(50); });
  assert.equal(seen.at(-1), held, "a list push with no newer stamp keeps the same workspace object");
  // The check lands: the feed pushes its read stamp (the list copy's), and the view shows it without a read.
  await act(async () => { live.set(listEntry(workspace({ ...full, prs: [pr({ snapshot: snapshot({ observedAt: at(90_000) }) })] }))); await wait(50); });
  assert.equal(seen.at(-1)?.prs[0]?.snapshot?.observedAt, at(90_000), "the newer read stamp reaches the open view");
  assert.equal(host.calls.filter(c => c === "follow.get").length, 1, "and costs no read");
  await act(() => { r.unmount(); });
  client.clear();
});

test("opening-reads-the-workspace-once: newerReadStamps takes only a newer stamp, and keeps the object when none is", () => {
  const w = workspace({ prs: [pr({ key: "example/app#1", snapshot: snapshot({ observedAt: at(10) }) })] });
  assert.equal(newerReadStamps(w, { "example/app#1": [at(5)] }), w, "an older stamp changes nothing");
  assert.equal(newerReadStamps(w, null), w);
  assert.equal(newerReadStamps(w, { "example/app#1": [at(20)] }).prs[0]!.snapshot!.observedAt, at(20));
  assert.equal(newerReadStamps(w, { "example/app#9": [at(20)] }), w, "a PR the workspace doesn't have");
});

test("opening-reads-the-workspace-once: the check the open view asks for sends its read stamps when it lands, inside the feed's window", async () => {
  const { WorkspacesFeed } = await import("../server/feeds");
  const { ListCache } = await import("../server/list-cache");
  const { READS_PUSH_MS } = await import("../shared/list");
  let now = clock;
  const one = (observed: string) => ({ version: 1, workspaces: [workspace({ id: "w1", prs: [pr({ snapshot: snapshot({ observedAt: observed }) })] })] }) as never;
  let s = one(at(0));
  const feed = new WorkspacesFeed(new ListCache(), async () => s, () => null, () => now);
  const got: { workspaces: unknown[]; reads: Record<string, [string]> }[] = [];
  const c = new AbortController();
  feed.serve(undefined, async e => { got.push(e as never); }, c.signal);
  await wait(10);
  // A background probe moves the stamp: held for the window (invariant 140).
  now = clock + 15_000; s = one(at(15_000)); await feed.changed();
  assert.equal(got.length, 1, "a background read waits out the window");
  // follow.refresh's tick lands (the open view asked for it): its stamps go now, with no workspace.
  now = clock + 20_000; s = one(at(20_000)); await feed.changed({ readsNow: true });
  assert.equal(got.length, 2, `sent ${READS_PUSH_MS - 20_000} ms before the window ends`);
  assert.deepEqual(got[1]!.workspaces, []);
  assert.equal(Object.values(got[1]!.reads.w1 ?? {})[0]?.[0], at(20_000), "carrying the check's stamp");
  // The window holds again after it.
  now = clock + 35_000; s = one(at(35_000)); await feed.changed();
  assert.equal(got.length, 2);
  c.abort();
});
