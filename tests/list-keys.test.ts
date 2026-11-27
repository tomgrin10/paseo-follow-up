import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listMove, overlayOver, ownsKey, stepKey, surfaceVisible, walkOrder, walkTarget } from "../shared/list-keys";
import { listEntries, type ListEntriesInput } from "../shared/list-entries";
import { sidebarSelected } from "../client/theme";

// one-keyboard-walk: Home and the sidebar view walk their rows with the same keys, through one hook.
test("plain keys walk the list; modified keys stay Paseo's own workspace shortcuts", () => {
  assert.equal(listMove({ key: "ArrowDown" }, false), "next");
  assert.equal(listMove({ key: "ArrowUp" }, false), "prev");
  assert.equal(listMove({ key: "j" }, false), "next");
  assert.equal(listMove({ key: "k" }, false), "prev");
  assert.equal(listMove({ key: "Home" }, false), "first");
  assert.equal(listMove({ key: "End" }, false), "last");
  assert.equal(listMove({ key: "Enter" }, false), "open");
  // ⌘[ ⌘] ⌘1…9 (Ctrl or Alt elsewhere) are Paseo's workspace.navigate bindings: never ours.
  for (const mod of ["metaKey", "ctrlKey", "altKey"]) assert.equal(listMove({ key: "ArrowDown", [mod]: true }, false), null, mod);
  assert.equal(listMove({ key: "J", shiftKey: true }, false), null);
  // Escape is Paseo's interrupt outside a text field, Space its voice toggle: not ours.
  assert.equal(listMove({ key: "Escape" }, false), null);
  assert.equal(listMove({ key: " " }, false), null);
});

test("in the list's own query field only the arrows count (they step into the list); j, k, Home, End and Enter type", () => {
  assert.equal(listMove({ key: "ArrowDown" }, true), "next");
  assert.equal(listMove({ key: "ArrowUp" }, true), "prev");
  for (const key of ["j", "k", "Home", "End", "Enter"]) assert.equal(listMove({ key }, true), null, key);
});

test("a step is one row, clamped at both ends; from nowhere it starts at the first row", () => {
  const order = ["brief", "overseer", "ws:a", "ws:b"];
  assert.equal(stepKey(order, "brief", "next"), "overseer");
  assert.equal(stepKey(order, "ws:b", "next"), "ws:b");
  assert.equal(stepKey(order, "brief", "prev"), "brief");
  assert.equal(stepKey(order, null, "next"), "brief");
  assert.equal(stepKey(order, "gone", "prev"), "brief");
  assert.equal(stepKey(order, "overseer", "last"), "ws:b");
  assert.equal(stepKey(order, "ws:b", "first"), "brief");
  assert.equal(stepKey([], null, "next"), null);
});

test("both surfaces walk through HomeList's one hook, in the list's own order with the brief and the Overseer", async () => {
  const src = (f: string) => readFile(join(import.meta.dirname, "..", "client", f), "utf8");
  const list = await src("home-list.tsx");
  assert.equal(list.match(/useListKeys\(/g)?.length, 1, "HomeList calls the hook once");
  // The order is the rows as drawn: the brief, the Overseer, then every row of an open group.
  assert.match(list, /walkOrder\(data\)/);
  // The brief and the Overseer rows are reachable by id, like workspace rows.
  assert.match(list, /nativeID=\{rowDomId\(BRIEF_KEY\)\}/);
  assert.match(list, /nativeID=\{rowDomId\(OVERSEER_KEY\)\}/);
  assert.match(await src("home.tsx"), /keys=\{\{ mode: "select"/);
  assert.match(await src("sidebar-view.tsx"), /keys=\{\{ mode: "focus"/);
  // Home and the sidebar view draw the same row ids side by side: the walk finds its row inside its own surface.
  assert.doesNotMatch(await src("list-keys.ts"), /getElementById/);
  // No other client file walks a list with its own arrow keydown listener.
  for (const f of ["home.tsx", "sidebar-view.tsx", "home-chrome.tsx", "inbox.tsx"]) assert.doesNotMatch(await src(f), /addEventListener\("keydown"[^)]*\)[\s\S]{0,400}ArrowDown/, f);
});

// A list with every kind of stop: Needs you open, Sending collapsed, Quiet with one fold open and one closed.
const ws = (key: string, group: string, project: string | null = null) => ({ key, group, project, readyToArchive: false, title: key, line: "", badges: [], sig: key }) as never;
const groups = [
  { id: "needs", title: "NEEDS YOU", items: [ws("ws:search", "needs"), ws("ws:contact", "needs")] },
  { id: "sending", title: "SENDING", items: [ws("ws:invoice", "sending")] },
  { id: "quiet", title: "QUIET", items: [ws("ws:api-a", "quiet", "api"), ws("ws:api-b", "quiet", "api"), ws("ws:web-a", "quiet", "web")] },
];
const input = (over: Partial<ListEntriesInput> = {}): ListEntriesInput => ({
  model: { groups, needs: 2, byKey: new Map(), hold: null, sort: "urgency", rankedAt: null } as never,
  closed: new Set(["sending"]), openProjects: new Set(["web"]), pages: {}, briefLine: "2 need you", results: null, hits: null,
  filter: null, overseer: true, touch: false, afterNeeds: false, ...over,
});

test("the walk is the rows as drawn: brief, Overseer, open groups; a collapsed group and a closed Quiet fold are skipped", () => {
  assert.deepEqual(walkOrder(listEntries(input())), ["brief", "overseer", "ws:search", "ws:contact", "ws:web-a"]);
  // The sidebar view: no brief; its Overseer row stays a stop.
  assert.deepEqual(walkOrder(listEntries(input({ briefLine: undefined }))), ["overseer", "ws:search", "ws:contact", "ws:web-a"]);
  // A search walks its results through the omnibox, not the list.
  assert.deepEqual(walkOrder(listEntries(input({ results: [] }))), []);
});

test("with the filter on only the matches are stops, and the arrows from the filter enter at the first match", () => {
  // The filter narrows the model (filterHome) and opens every group and fold holding a match.
  const filtered = { ...input().model, groups: [{ id: "needs", title: "NEEDS YOU", items: [ws("ws:contact", "needs")] }, { id: "quiet", title: "QUIET", items: [ws("ws:api-b", "quiet", "api")] }] } as never;
  const order = walkOrder(listEntries(input({ model: filtered, briefLine: undefined, overseer: false, hits: new Map([["ws:contact", { titleRanges: [], via: null } as never], ["ws:api-b", { titleRanges: [], via: null } as never]]) })));
  assert.deepEqual(order, ["ws:contact", "ws:api-b"]);
  assert.equal(walkTarget({ order, focused: null, selectedKey: "ws:api-b", mode: "focus", typing: true, move: "next" }), "ws:contact");
  // Home's empty search enters at the selection instead.
  assert.equal(walkTarget({ order: ["brief", "ws:search", "ws:contact"], focused: null, selectedKey: "ws:contact", mode: "select", typing: true, move: "next" }), "ws:contact");
  assert.equal(walkTarget({ order: ["brief", "ws:search"], focused: "brief", selectedKey: null, mode: "select", typing: false, move: "next" }), "ws:search");
});

test("keys belong to the surface holding focus: Home never walks while focus is in the sidebar view", () => {
  // Focus in the sidebar view: Home (claimBody) doesn't own it; the sidebar view does.
  assert.equal(ownsKey({ inside: false, onBody: false, claimBody: true, visible: true }), false);
  assert.equal(ownsKey({ inside: true, onBody: false, claimBody: false, visible: true }), true);
  // Nothing focused: Home's, never the sidebar view's.
  assert.equal(ownsKey({ inside: false, onBody: true, claimBody: true, visible: true }), true);
  assert.equal(ownsKey({ inside: false, onBody: true, claimBody: false, visible: true }), false);
});

test("an open row menu or its confirm step keeps every key, even while focus sits on the page", async () => {
  // 2026-11-23 (Archive workspace… render): Esc from the confirm step back to the menu left focus on the page for a
  // frame, and Enter there opened the selected workspace's chat behind the menu.
  for (const inside of [false, true]) assert.equal(ownsKey({ inside, onBody: !inside, claimBody: true, visible: true, overlayOpen: true }), false);
  const src = (f: string) => readFile(join(import.meta.dirname, "..", "client", f), "utf8");
  const hook = await src("list-keys.ts");
  const overlays = hook.match(/const OVERLAYS = '([^']+)'/)?.[1] ?? "";
  for (const role of ['[role="menu"]', '[role="alertdialog"]', '[aria-modal="true"]']) assert.ok(overlays.includes(role), `${role} owns its keys`);
  // Home's keys sheet is a non-modal dialog beside the list: S must still close it (home-keys "S again hides them").
  assert.ok(!overlays.split(",").includes('[role="dialog"]'), "a non-modal dialog leaves the list its keys");
  assert.match(await src("catch-up.tsx"), /<FloatingSurface modal=\{false\}[^>]*label=\{label\}/, "the keys sheet is that non-modal dialog");
  assert.match(hook, /overlayOpen: overlayOver\(doc\.querySelectorAll\?\.\(OVERLAYS\) \?\? \[\], root\)/, "the walk asks whether one is over the list on every key");
  assert.match(await src("row-menu.tsx"), /role=\{confirm \? "alertdialog" : "menu"\}/, "the row menu's two roles are the ones listed");
});

test("only a menu or dialog drawn over the list keeps its keys, not one around it or one kept mounted closed", () => {
  // 2026-11-23 (#291 review): a document-wide check would leave Home's keys dead for good inside a dialog or sheet that
  // hosts it, or while Paseo keeps a closed overlay mounted.
  const root = { id: "list root" };
  const el = (o: { hosts?: boolean; shown?: boolean; engine?: boolean }) => ({
    contains: (other: unknown) => !!o.hosts && other === root,
    getClientRects: () => ({ length: o.shown === false ? 0 : 1 }),
    ...(o.engine ? { checkVisibility: () => o.shown !== false } : {}),
  });
  const menu = el({}), confirm = el({ engine: true });
  assert.equal(overlayOver([menu], root), true, "the open row menu blocks");
  assert.equal(overlayOver([confirm], root), true, "its confirm step blocks");
  assert.equal(overlayOver([el({ hosts: true })], root), false, "a dialog that hosts the list does not block");
  assert.equal(overlayOver([el({ shown: false })], root), false, "a hidden overlay does not block");
  assert.equal(overlayOver([el({ shown: false, engine: true })], root), false, "hidden per checkVisibility does not block");
  assert.equal(overlayOver([el({ hosts: true }), menu], root), true, "a menu inside the hosting dialog still blocks");
  assert.equal(overlayOver([], root), false);
});

test("a mounted but hidden Home never takes a body key", async () => {
  // Paseo may keep a plugin screen mounted behind another tab or chat: a body key there scrolls the chat, not Home.
  assert.equal(ownsKey({ inside: false, onBody: true, claimBody: true, visible: false }), false);
  const shown = { checkVisibility: () => true, getClientRects: () => ({ length: 1 }) };
  const hidden = { checkVisibility: () => false, getClientRects: () => ({ length: 0 }) };
  assert.equal(surfaceVisible(shown, { visibilityState: "visible" }), true);
  assert.equal(surfaceVisible(hidden, { visibilityState: "visible" }), false);
  // A background browser tab or window.
  assert.equal(surfaceVisible(shown, { visibilityState: "hidden" }), false);
  // No checkVisibility (older engines): laid-out boxes decide; display:none has none.
  assert.equal(surfaceVisible({ getClientRects: () => ({ length: 1 }) }, {}), true);
  assert.equal(surfaceVisible({ getClientRects: () => ({ length: 0 }) }, {}), false);
  // No root yet: not visible.
  assert.equal(surfaceVisible(null, { visibilityState: "visible" }), false);
  // The hook gates the body claim on it.
  const hook = await readFile(join(import.meta.dirname, "..", "client", "list-keys.ts"), "utf8");
  assert.match(hook, /visible: !!claimBody && surfaceVisible\(/);
});

test("phones and native draw no listener; the sidebar's selected row wears Paseo's selected-item fill", async () => {
  const src = (f: string) => readFile(join(import.meta.dirname, "..", "client", f), "utf8");
  // On while a search shows results (the walk has no rows then; Enter opens the selection): the-selected-workspace-opens-with-enter.
  assert.match(await src("home-list.tsx"), /enabled: !!keys && !touch, order/);
  assert.match(await src("list-keys.ts"), /Platform\.OS !== "web"/);
  // Light: two steps under the sidebar's surface2 (#f4f4f5 -> about #d4d4d8, Paseo's surface4); dark: surface2.
  const light = { surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", foreground: "#1a1a1e" } as never;
  assert.equal(sidebarSelected(light), "rgba(26, 26, 30, 0.14)");
  const dark = { surface0: "#18181b", surface1: "#1f1f23", surface2: "#27272a", foreground: "#fafafa" } as never;
  assert.equal(sidebarSelected(dark), "#27272a");
  assert.match(await src("sidebar-view.tsx"), /selectedBg=\{sidebarSelected\(c\)\}/);
});
