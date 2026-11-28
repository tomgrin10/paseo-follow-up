// Invariant 149, a-card-resize-redraws-no-other-card (client/panel.tsx Columns). 2026-11-27, the developer: "Needs you
// question open felt laggy". The broad perf check found why on the web's wide panel: every card reported its measured
// height to WorkspaceView's own state, so a question picked or closed in Needs you (its card grows or shrinks) redrew
// the whole panel, 3,400-3,600 components (every PR row, task and Activity row) for one tap. The heights now live in
// the columns: a card that changes height redraws the columns alone, and every card in them is skipped.
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
import { obligationSchema } from "../shared/model";
import { questionSchema } from "../shared/questions";

const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = join(import.meta.dirname, "..");
type Probe = { texts: number; layouts: { testID?: string; onLayout: (e: unknown) => void }[] };
type ViewModule = { WorkspaceView: (p: Record<string, unknown>) => unknown };
/** WorkspaceView bundled for Node: React Native's views draw their children, and the probe counts every Text drawn. */
async function bundleView(): Promise<ViewModule> {
  const dir = join(root, "node_modules", ".cache", "follow-card-resize");
  await mkdir(dir, { recursive: true });
  const stub = join(dir, "stub.cjs");
  // Named exports are listed (esbuild's CommonJS interop copies own keys), read from the client's own imports.
  const names = new Set<string>();
  for (const f of (await readdir(join(root, "client"))).filter(f => /\.tsx?$/.test(f))) {
    const src = await readFile(join(root, "client", f), "utf8");
    for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"(react-native|@getpaseo\/plugin\/client(?:\/ui)?)"/g)) for (const n of m[1]!.split(",")) { const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]; if (name) names.add(name); }
  }
  (globalThis as { __cardResizeReact?: unknown }).__cardResizeReact = React;
  await writeFile(stub, `const R = globalThis.__cardResizeReact;
const probe = globalThis.__cardResizeProbe;
const pass = p => R.createElement(R.Fragment, null, typeof p.children === "function" ? p.children({}) : p.children ?? null);
// A component draws its children; anything else (Easing.bezier, Animated.Value…) is an inert value of any shape.
const statics = new Set(["prototype", "$$typeof", "defaultProps", "displayName", "contextType", "contextTypes", "childContextTypes", "getDerivedStateFromProps", "propTypes", "compare", "render", "type", "then"]);
const deep = new Proxy(function Stub() {}, { get: (_t, k) => typeof k === "symbol" || statics.has(k) ? undefined : deep, construct: () => deep,
  apply: (_t, _self, args) => args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) && args.length <= 2 ? pass(args[0]) : deep });
const View = R.forwardRef((p, _ref) => { if (p.onLayout) probe.layouts.push({ testID: p.testID, onLayout: p.onLayout }); return pass(p); });
const Text = p => { probe.texts++; return pass(p); };
const FlatList = p => R.createElement(R.Fragment, null, ...(p.data ?? []).map((item, index) => R.createElement(R.Fragment, { key: p.keyExtractor ? p.keyExtractor(item, index) : index }, p.renderItem({ item, index }))));
const special = { View, Text, FlatList, Platform: { OS: "web", select: o => o.web ?? o.default }, StyleSheet: { create: s => s, hairlineWidth: 1, flatten: s => s }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) }, AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
  useRpc: () => async () => ({}), useToast: () => ({ show() {}, error() {} }), useTabState: (_k, init) => R.useState(init), useAgent: () => null, useSubscription: () => undefined };
for (const name of ${JSON.stringify([...names])}) exports[name] = special[name] ?? deep;`);
  const out = join(dir, "view.mjs");
  await build({
    stdin: { contents: `export { WorkspaceView } from "./client/panel";`, resolveDir: root, loader: "ts" },
    bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic",
    alias: { "react-native": stub, "@getpaseo/plugin/client/ui": stub, "@getpaseo/plugin/client": stub },
    external: ["react", "react/*", "zod", "@tanstack/*", "@getpaseo/plugin", "lucide-react-native"],
  });
  return import(`${pathToFileURL(out).href}?t=${Date.now()}`) as Promise<ViewModule>;
}

const at = new Date(clock).toISOString();
const ask = (n: number) => questionSchema.parse({ id: `Q${n}`, title: `Pick a rollout window ${n}`, question: "Which window should the migration run in?", options: [{ letter: "A", label: "Tonight" }, { letter: "B", label: "Tomorrow" }], askedBy: "main-agent", askedAt: at, mode: "stop" });
// A busy workspace, the way the panel's cost shows: open questions in Needs you, a stack of PRs and a list of tasks.
const busy = workspace({
  questions: [1, 2, 3].map(ask),
  prs: Array.from({ length: 8 }, (_, i) => pr({ key: `example/app#${i + 1}`, number: i + 1, parent: i ? `example/app#${i}` : null, snapshot: snapshot({ title: `Migration step ${i + 1}`, url: `https://github.com/example/app/pull/${i + 1}` }) })),
  obligations: Array.from({ length: 10 }, (_, i) => obligationSchema.parse({ id: `t${i}`, title: `Backfill table ${i}`, status: "waiting", afterPrs: [], evidence: "", enable_follow_up: true, revision: 0 })),
});

test("a-card-resize-redraws-no-other-card: a card that grows in the wide panel redraws no card", { timeout: 60_000 }, async () => {
  const probe: Probe = { texts: 0, layouts: [] };
  (globalThis as { __cardResizeProbe?: Probe }).__cardResizeProbe = probe;
  const { WorkspaceView } = await bundleView();
  const theme = { colors: new Proxy({}, { get: () => "#000" }) };
  const open = new Set<string>(["needs", "prs", "tasks", "activity"]);
  const props = { theme, layout: { compact: false }, workspace: busy, folds: { isOpen: (k: string) => open.has(k), toggle: () => undefined }, openSettings: () => undefined, openOverview: () => undefined, resize: null, place: "panel" };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let r!: { unmount(): void };
  await act(() => { r = create(createElement(QueryClientProvider, { client }, createElement(WorkspaceView as never, props as never))); });
  // The panel is measured wide (three columns), then every card reports its height once.
  const view = probe.layouts.filter(l => l.testID === "follow-up-view-panel").at(-1);
  assert.ok(view, "the view reports its width");
  const mark = probe.layouts.length, drawnNarrow = probe.texts;
  await act(() => { view.onLayout({ nativeEvent: { layout: { width: 1600, height: 900, x: 0, y: 0 } } }); });
  assert.ok(probe.texts - drawnNarrow > 50, `the wide panel draws its cards (${probe.texts - drawnNarrow} texts)`);
  // Each card's slot reports its height (Slot's onLayout); the scroll and Activity measure themselves for other reasons.
  const slots = probe.layouts.slice(mark).filter(l => !l.testID && /\bonHeight\(/.test(String(l.onLayout)));
  assert.ok(slots.length >= 5, `the cards sit in measured slots (${slots.length})`);
  await act(() => { for (const s of slots) s.onLayout({ nativeEvent: { layout: { width: 400, height: 200, x: 0, y: 0 } } }); });
  // One card grows (a question opened, picked or closed in Needs you).
  const drawn = probe.texts;
  await act(() => { slots[0]!.onLayout({ nativeEvent: { layout: { width: 400, height: 260, x: 0, y: 0 } } }); });
  assert.equal(probe.texts - drawn, 0, `one card's new height redrew ${probe.texts - drawn} texts: the heights belong to the columns, never WorkspaceView`);
  await act(() => { r.unmount(); });
  client.clear();
});
