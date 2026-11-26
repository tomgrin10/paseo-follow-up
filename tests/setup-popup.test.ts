// setup-is-one-popup (client/setup-gate.tsx, shared/setup-popup.ts): setup is one popup, from the welcome page through
// the steps to done, on whichever Follow-up surface mounts first. Close (X) only puts it away on this device: setup stays
// on its step, the server hears nothing, and Home keeps a "Finish setup" line that opens it again on that step. Existing
// installs and upgrades see no popup and keep What's new; agents' setup tools are unchanged. The gate renders under the
// strict native stand-in; fixtures are fictional.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ONBOARDING_ACTIONS, type OnboardingView } from "../shared/onboarding";
import { whatsNew, type ReleaseNote } from "../shared/changelog";
import { SETUP_CLOSED_KEY, finishSetupLine, setupOwner, setupPopup } from "../shared/setup-popup";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, unknown> };
type Root = { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown, o?: unknown) => Root; act: (f: () => Promise<void> | void) => Promise<void> };
const { rpc, rpcCalls } = await import("./support/native/plugin-client.mjs" as string) as { rpc: { reply: (name: string, input: unknown) => unknown }; rpcCalls: { name: string; input: unknown }[] };
const { SetupGate, FinishSetupLine, resetSetupSession } = await import("../client/setup-gate");
const { deviceStorage } = await import("../shared/settings-nav");

const view = (over: Partial<OnboardingView> = {}): OnboardingView => ({ install: "fresh", status: "new", step: "intro", show: true, offer: false, holdsAutoSends: true, ...over });
const note = (version: string): ReleaseNote => ({ version, date: "2026-11-20", items: ["A change."] });

// ---------- the rules ----------

test("a first install opens the popup; existing installs, upgrades and settled setups never do", () => {
  assert.equal(setupPopup({ view: view(), closed: false, done: false }), "open");
  assert.equal(setupPopup({ view: view({ status: "active", step: "defaults" }), closed: false, done: false }), "open");
  for (const status of ["idle", "done", "skipped"] as const)
    assert.equal(setupPopup({ view: view({ install: "existing", status, show: false, holdsAutoSends: false }), closed: false, done: false }), "none", status);
  assert.equal(setupPopup({ view: undefined, closed: false, done: false }), "none", "nothing decides before the view loads");
});

test("Close puts the popup away on this device only; Home's Finish setup line names where setup stopped", () => {
  const v = view({ status: "active", step: "defaults" });
  assert.equal(setupPopup({ view: v, closed: true, done: false }), "closed");
  assert.deepEqual(finishSetupLine(v, true), { label: "Finish setup", step: "defaults" });
  assert.equal(finishSetupLine(v, false), null, "no line while the popup is open");
  assert.equal(finishSetupLine(view({ install: "existing", status: "done", show: false }), true), null, "no line once setup is over");
  assert.equal(SETUP_CLOSED_KEY, "follow-up.setup.closed");
});

test("the done page stays up after Finish, though the server already says setup is over", () => {
  assert.equal(setupPopup({ view: view({ status: "done", show: false, holdsAutoSends: false }), closed: false, done: true }), "open");
});

test("one popup per app session: the first surface to mount draws it", () => {
  assert.equal(setupOwner(null, "sidebar"), "sidebar");
  assert.equal(setupOwner("sidebar", "home"), "sidebar");
  assert.equal(setupOwner("home", "home"), "home");
});

test("upgrades keep What's new; a first install shows no notes during or after setup", () => {
  const notes = [note("2.5.0"), note("2.4.0")];
  assert.deepEqual(whatsNew({ installed: "2.5.0", deviceSeen: "2.4.0", previous: "2.4.0", onboarding: false, notes }), { show: true, notes: [notes[0]] });
  assert.deepEqual(whatsNew({ installed: "2.5.0", deviceSeen: null, previous: null, onboarding: true, notes }), { show: false, reason: "onboarding", record: null });
  assert.deepEqual(whatsNew({ installed: "2.5.0", deviceSeen: null, previous: null, onboarding: false, notes }), { show: false, reason: "first-run", record: "2.5.0" });
});

test("agents' setup tools are unchanged: same actions, same tools", () => {
  assert.deepEqual([...ONBOARDING_ACTIONS], ["start", "step", "finish", "skip", "restart", "dismiss-offer"]);
  const mcp = readFileSync(new URL("../server/mcp.mjs", import.meta.url), "utf8");
  for (const tool of ["onboarding_status", "onboarding_checks", "set_onboarding"]) assert.match(mcp, new RegExp(`\\["${tool}", `), tool);
});

test("every surface that can pop What's new can pop setup", () => {
  for (const file of ["client/home.tsx", "client/panel.tsx", "client/live.tsx"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(src, /<SetupGate surface="[a-z]+"/, file);
  }
});

// ---------- the gate, rendered ----------

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let current = view();
rpc.reply = (name: string, input: unknown) => {
  if (name === "follow.onboarding") return current;
  if (name === "follow.set-onboarding") {
    const { action, step } = input as { action: string; step?: OnboardingView["step"] };
    if (action === "step" && step) current = { ...current, status: "active", step };
    return current;
  }
  if (name === "follow.onboarding-checks") return { checks: [], checkedAt: "2026-11-26T10:00:00.000Z" };
  if (name === "follow.pr-workflow") return { repos: [] };
  if (name === "follow.reviewer-settings") return { repos: [], config: { defaults: [], repos: {} } };
  if (name === "follow.updates") return { installKind: "git", phase: { kind: "idle" } };
  if (name === "follow.follow-settings") return { workspaces: [], enable_follow_every: true, enable_auto_sends_default: false };
  if (name === "follow.release-notes") return { version: "2.5.0", name: "Follow-up", installKind: "npm", previous: null, updatedAt: null, hostSeen: null, enable_whats_new: true, notes: [], releases: null };
  return {};
};
const tick = (ms = 40) => act(async () => { await new Promise(res => setTimeout(res, ms)); });
async function mount(el: unknown): Promise<Root> {
  let r: Root | undefined;
  const orig = console.error; console.error = () => {};
  try { await act(async () => { r = create(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, el)); }); await tick(); } finally { console.error = orig; }
  return r!;
}
const dialogs = (r: Root) => r.root.findAll(n => typeof n.type === "string" && n.props["aria-label"] === "Set up Follow-up" && (n.props.role === "dialog" || n.props.title !== undefined)).length;
const pressable = (r: Root, label: string) => r.root.findAll(n => typeof n.props.onPress === "function" && (n.props.accessibilityLabel === label)).at(0);
const progress = (r: Root) => r.root.findAll(n => n.props.accessibilityRole === "progressbar").map(n => n.props.accessibilityLabel as string).at(0) ?? null;
const desktop = false;

test("a first install pops the popup on whichever surface mounts first, once", async () => {
  current = view(); resetSetupSession(); deviceStorage.set(SETUP_CLOSED_KEY, null as never);
  const sidebar = await mount(createElement(SetupGate, { surface: "sidebar", theme, compact: desktop }));
  const panel = await mount(createElement(SetupGate, { surface: "panel", theme, compact: desktop }));
  assert.equal(dialogs(sidebar), 1, "the sidebar mounted first and shows the welcome page");
  assert.equal(dialogs(panel), 0, "one popup per app session");
  await act(async () => { sidebar.unmount(); panel.unmount(); });
});

test("Close keeps the step and tells the server nothing; Finish setup reopens there; Continue moves through the same RPC", async () => {
  current = view({ status: "active", step: "defaults" }); resetSetupSession(); deviceStorage.set(SETUP_CLOSED_KEY, null as never);
  const gate = await mount(createElement(SetupGate, { surface: "home", theme, compact: desktop }));
  assert.equal(dialogs(gate), 1);
  assert.match(progress(gate) ?? "", /^Step 2 of \d+$/, "opens on the saved step");
  const before = rpcCalls.filter(c => c.name === "follow.set-onboarding").length;
  await act(async () => { (pressable(gate, "Close")!.props.onPress as () => void)(); }); await tick();
  assert.equal(dialogs(gate), 0, "Close puts it away");
  assert.equal(rpcCalls.filter(c => c.name === "follow.set-onboarding").length, before, "Close sends nothing: setup stays on its step");
  assert.equal(current.step, "defaults");
  const line = await mount(createElement(FinishSetupLine, { theme, compact: desktop }));
  const open = pressable(line, "Finish setup");
  assert.ok(open, "Home shows Finish setup");
  await act(async () => { (open!.props.onPress as () => void)(); }); await tick();
  assert.equal(dialogs(gate), 1, "Finish setup opens the popup again");
  assert.match(progress(gate) ?? "", /^Step 2 of \d+$/, "on the step it was left on");
  await act(async () => { (pressable(gate, "Continue")!.props.onPress as () => void)(); }); await tick();
  assert.deepEqual(rpcCalls.filter(c => c.name === "follow.set-onboarding").at(-1)?.input, { action: "step", step: current.step }, "a move is the same set-onboarding step agents send");
  await act(async () => { gate.unmount(); line.unmount(); });
});

test("an existing install or an upgrade sees no popup and no Finish setup line", async () => {
  current = view({ install: "existing", status: "idle", show: false, holdsAutoSends: false }); resetSetupSession();
  const gate = await mount(createElement(SetupGate, { surface: "home", theme, compact: desktop }));
  const line = await mount(createElement(FinishSetupLine, { theme, compact: desktop }));
  assert.equal(dialogs(gate), 0);
  assert.equal(pressable(line, "Finish setup"), undefined);
  await act(async () => { gate.unmount(); line.unmount(); });
});
