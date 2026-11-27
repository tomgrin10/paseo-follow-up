// a-disclosure-reveals-beside-itself (AGENTS.md invariant 41, 2026-11-27 line). The developer on a phone: tapping the ⓘ
// in the timeline card's header "does nothing". It toggled the card's "where this comes from" line, but that line was
// drawn as the card's footer, so on a tall card (three questions) it appeared far below the screen and only the
// icon's tint changed. On phones the line now sits right after the header row; desktop keeps its footer.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { questionSchema } from "../shared/questions";
import { briefSchema } from "../shared/brief";
import { clock, workspace } from "./fixtures";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any>; children: unknown[]; parent: Node | null };
type Rendered = { root: Node & { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => Rendered; act: (f: () => Promise<void> | void) => Promise<void> };
const { BriefCard } = await import("../client/brief");
const { rpc } = await import("./support/native/plugin-client.mjs" as string) as { rpc: { reply: (name: string, input: unknown) => unknown } };
const colors = new Proxy({}, { get: () => "#888888" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = new Date(clock).toISOString();
const SOURCE = "Stated by the agent.";
const questions = ["Q1", "Q2", "Q3"].map(id => questionSchema.parse({ id, title: `Sidebar ${id}`, question: `Which sidebar option for ${id}?`, askedBy: "main-agent", askedAt: at, mode: "stop",
  background: "My review adds: a note.", links: [{ label: "Sidebar design page", url: "https://example.com/acme/sidebar" }], options: [{ letter: "A", label: "One" }, { letter: "B", label: "Two" }] }));
const w = workspace({ questions });
const b = briefSchema.parse({ id: "brief:t1", source: "agent", kind: "decision", ask: "Three calls on the sidebar", at, sourceLine: SOURCE, workspaceId: w.id, questionIds: questions.map(q => q.id),
  decisions: questions.map(q => ({ id: q.id, question: q.question, options: q.options })) });
// The card asks the worker whether this brief is still the open one: it is.
rpc.reply = name => name === "follow.inbox-brief" ? { brief: b } : null;
const clients: QueryClient[] = [];
test.after(() => { for (const c of clients) c.clear(); });
const deps = { signOff() {}, openNext() {}, openAgent() {}, openPanel() {}, workspace: () => w };

const textOf = (n: unknown): string => typeof n === "string" ? n : n && typeof n === "object" && "children" in n ? ((n as Node).children ?? []).map(textOf).join("") : "";
async function card(compact: boolean): Promise<Rendered> {
  let r!: Rendered;
  const orig = console.error; console.error = () => {};
  try { await act(async () => { r = create(createElement(QueryClientProvider, { client: clients[clients.push(new QueryClient({ defaultOptions: { queries: { retry: false } } })) - 1] }, createElement(BriefCard, { item: { data: b }, theme: { colors }, layout: { compact }, agentId: "main-agent", deps }))); await new Promise(res => setTimeout(res, 20)); }); }
  finally { console.error = orig; }
  return r;
}
/** The host element holding the source line, and where it sits: its index among its parent's children vs the header's. */
function sourceLine(r: Rendered) {
  const hosts = r.root.findAll(n => typeof n.type === "string" && textOf(n) === SOURCE);
  return hosts[0] ?? null;
}

test("phones: the ⓘ reveals the source line right after the header row, before the ask", async () => {
  const r = await card(true);
  try {
  assert.equal(sourceLine(r), null, "hidden until ⓘ is pressed");
  const info = r.root.findAll(n => typeof n.props.onPress === "function" && n.props.accessibilityLabel === "Where this comes from")[0];
  assert.ok(info, "the ⓘ");
  await act(() => { info.props.onPress(); });
  const line = sourceLine(r);
  assert.ok(line, "shown after the press");
  // The header row is the View holding the ⓘ; the element right after it, among its siblings, is the line.
  let row: Node | null = info; while (row && !(row.parent?.children ?? []).some(k => typeof k === "object" && textOf(k).includes(SOURCE))) row = row.parent;
  assert.ok(row, "the line is a sibling of the header row");
  const kids = (row.parent!.children as Node[]).filter(k => typeof k === "object");
  const at = kids.indexOf(row);
  assert.ok(textOf(kids[at + 1]).includes(SOURCE), `the element right after the header row is the line (got "${textOf(kids[at + 1]).slice(0, 60)}")`);
  // And it is above every question, not under them.
  const all = textOf(r.root);
  assert.ok(all.indexOf(SOURCE) < all.indexOf("Which sidebar option for Q1?"));
  } finally { r.unmount(); }
});

test("desktop: the source line stays the card's footer, after the questions", async () => {
  const r = await card(false);
  try {
    const all = textOf(r.root);
    assert.ok(all.includes(SOURCE));
    assert.ok(all.lastIndexOf(SOURCE) > all.indexOf("Which sidebar option for Q3?"));
  } finally { r.unmount(); }
});
