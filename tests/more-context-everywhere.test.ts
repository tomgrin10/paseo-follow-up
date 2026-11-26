// more-context-is-the-same-on-every-surface (AGENTS.md invariant 58). 2026-11-18, Tom: "I want the option to add
// context to questions outside of catch up too". More context lived only on Catch up's card; the panel, Home's detail
// pane, the question dialog, the pill and phones answer the same questions with QuestionBody and had none. And an ask
// was keyed by Catch up's workstream key only (`agent:<id>|Q1`), so the same question asked from elsewhere would have
// been a second card: a second ask to the agent, and an answer the other surface never shows. These render the real
// QuestionBody under the strict native stand-in (the phone's rules, invariant 51) over a fake ask store, and run the
// worker's ask store and the shared matcher every reader uses.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { questionSchema, type Question } from "../shared/questions";
import { CONTEXT_ASKS, contextFor, questionCardKey, sameCard, type ContextRequest } from "../shared/catch-up";
import { ContextRequests } from "../server/context-requests";
import { clock, workspace } from "./fixtures";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testStore, rm } from "./support/store-temp-dir";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { QuestionBody } = await import("../client/questions");
const { setContextSource } = await import("../client/more-context");
const use = (next: unknown) => act(() => { setContextSource(next as never); });

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const question: Question = questionSchema.parse({
  id: "Q1", title: "Which retry policy?", question: "How should failed charges retry?", askedBy: "main-agent",
  askedAt: new Date(clock).toISOString(), mode: "stop", recommended: "A",
  options: [{ letter: "A", label: "Retry once after a day" }, { letter: "B", label: "Never retry" }],
});
const w = workspace({ questions: [question] });

const ask = (over: Partial<ContextRequest>): ContextRequest => ({ id: "ctx-1", workspaceId: w.id, agentId: "main-agent", cardKey: questionCardKey(w.id, "Q1"), card: "Q1 · Which retry policy?",
  target: "agent", ask: CONTEXT_ASKS[0].text, askedOf: w.mainAgentId, state: "asking", answer: null, error: null, askedAt: new Date(clock).toISOString(), settledAt: null, deliveredAt: null, by: "developer", via: "more", parentId: null, readAt: null, done: null, task: null, ...over });

/** One store for every surface, like Home's extras: what it holds, who listens, and what was asked through it. */
function source(requests: ContextRequest[] = [], fail: string | null = null) {
  const listeners = new Set<() => void>();
  const asked: Record<string, unknown>[] = [];
  let value = requests;
  return {
    asked,
    set(next: ContextRequest[]) { value = next; for (const l of listeners) l(); },
    context: () => value,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    reads: 0,
    async refreshContext() { this.reads++; },
    async askContext(input: Record<string, unknown>) {
      asked.push(input);
      if (fail) throw new Error(fail);
      const request = ask({ id: `ctx-${asked.length}`, cardKey: String(input.cardKey), ask: String(input.ask) });
      value = [...value, request]; for (const l of listeners) l();
      return { request };
    },
  };
}

async function card(props: Record<string, unknown> = {}) {
  const client = new QueryClient();
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try { await act(() => { r = create(createElement(QueryClientProvider, { client }, createElement(QuestionBody, { workspace: w, question, theme, compact: true, now: clock, openAgent: () => {}, ...props }))); }); }
  finally { console.error = orig; }
  const all = (f: (n: Node) => boolean) => r.root.findAll(f);
  const label = (re: RegExp) => all(n => typeof n.props.onPress === "function" && re.test(String(n.props.accessibilityLabel ?? "")));
  const press = async (re: RegExp) => { const n = label(re)[0]; assert.ok(n, `a control labelled ${re}`); await act(async () => { await n.props.onPress(); await new Promise(res => setTimeout(res, 10)); }); };
  const texts = () => all(n => n.type === "Text" || (typeof n.props.children === "string")).map(n => [n.props.children].flat().filter(x => typeof x === "string").join("")).join("\n");
  return { label, press, texts, all, unmount: () => r.unmount() };
}

test("one question is one card wherever it is asked from: Catch up's workstream key and the question's own key match", () => {
  const panel = { workspaceId: "w1", cardKey: questionCardKey("w1", "Q1") };
  assert.ok(sameCard(panel, { workspaceId: "w1", cardKey: "agent:a1|Q1" }), "Catch up's agent workstream");
  assert.ok(sameCard(panel, { workspaceId: "w1", cardKey: "ws:w1|Q1" }), "Catch up's workspace workstream");
  assert.ok(!sameCard(panel, { workspaceId: "w2", cardKey: "agent:a1|Q1" }), "another workspace's Q1 is another question");
  assert.ok(!sameCard(panel, { workspaceId: "w1", cardKey: "agent:a1|Q2" }), "another question");
  // Only questions are workspace-wide: two agents' finished turns in one workspace stay two cards.
  assert.ok(!sameCard({ workspaceId: "w1", cardKey: "agent:a1|finished" }, { workspaceId: "w1", cardKey: "agent:a2|finished" }));
  const fromPanel = ask({ id: "p" });
  assert.equal(contextFor([fromPanel], { workspaceId: w.id, cardKey: "agent:main-agent|Q1" })?.id, "p", "Catch up's card shows an ask made from the panel");
  const fromCatchUp = ask({ id: "c", cardKey: "agent:main-agent|Q1" });
  assert.equal(contextFor([fromPanel, fromCatchUp], panel.workspaceId === w.id ? panel : { workspaceId: w.id, cardKey: questionCardKey(w.id, "Q1") })?.id, "c", "the newest ask wins");
});

test("the worker keeps one open ask per question, whichever surface asks", async t => {
  const dir = await mkdtemp(join(tmpdir(), "more-context-"));
  const store = testStore(ContextRequests, dir, () => clock);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = { workspaceId: "w1", agentId: "a1", card: "Q1 · Which retry policy?", target: "agent" as const, ask: "I don't get it" };
  const first = await store.ask({ ...input, cardKey: questionCardKey("w1", "Q1") }, "developer", "main");
  const again = await store.ask({ ...input, cardKey: "agent:a1|Q1" }, "developer", "main");
  assert.equal(first.fresh, true);
  assert.equal(again.fresh, false, "Catch up's ask about the same question joins the panel's");
  assert.equal(again.request.id, first.request.id);
  assert.equal((await store.ask({ ...input, workspaceId: "w2", cardKey: "agent:a1|Q1" }, "developer", "main")).fresh, true, "another workspace's Q1 is its own ask");
});

test("idle: an open question outside Catch up has a quiet More context link, and Catch up's own card has none", async () => {
  await use(source());
  const c = await card();
  assert.ok(c.label(/^More context on Q1$/).length > 0, "the link on the question card");
  assert.equal(c.label(/^Ask the agent/).length, 0, "nothing open yet");
  c.unmount();
  const inCatchUp = await card({ moreContext: false });
  assert.equal(inCatchUp.label(/^More context on Q1$/).length, 0, "Catch up's move bar has More context; the question in it doesn't repeat it");
  inCatchUp.unmount();
  await use(null);
  const none = await card();
  assert.equal(none.label(/^More context on Q1$/).length, 0, "no store, no dead link");
  none.unmount();
});

test("asking: the link opens Catch up's panel, I don't get it first, and Ask sends the one request to the question's card", async () => {
  const s = source(); await use(s);
  const c = await card();
  await c.press(/^More context on Q1$/);
  const chips = c.all(n => n.props.accessibilityRole === "radio" && typeof n.props.onPress === "function" && CONTEXT_ASKS.some(a => a.label === n.props.accessibilityLabel));
  assert.equal(chips[0]?.props.accessibilityLabel, "I don't get it", "I don't get it leads");
  assert.ok(c.all(n => n.props.accessibilityLabel === "What do you want to know?").length, "then your own words");
  assert.ok(c.all(n => n.props.accessibilityLabel === "More context" && n.props.role === "dialog").length, "in Catch up's sheet (MoveResult)");
  await c.press(/^Ask the agent/);
  assert.deepEqual(s.asked, [{ workspaceId: w.id, agentId: "main-agent", cardKey: questionCardKey(w.id, "Q1"), card: "Q1 · Which retry policy?", ask: CONTEXT_ASKS[0].text }]);
  c.unmount(); await use(null);
});

test("pending: an ask made in Catch up shows on the panel's card as waiting, with no second Ask", async () => {
  await use(source([ask({ cardKey: "agent:main-agent|Q1" })]));
  const c = await card();
  assert.match(c.texts(), /Asked the agent · the answer shows here when it comes/);
  assert.equal(c.label(/^More context on Q1$/).length, 0, "no second ask while one is open");
  c.unmount(); await use(null);
});

test("replied: the answer lands on the question, live, with Ask more", async () => {
  const s = source([ask({})]); await use(s);
  const c = await card();
  await act(() => { s.set([ask({ state: "answered", answer: "Retrying once catches most soft declines." })]); });
  assert.match(c.texts(), /Retrying once catches most soft declines\./);
  assert.match(c.texts(), /you asked: I don't get it\./);
  assert.ok(c.label(/^More context on Q1$/).length > 0, "ask again from the same link");
  assert.match(c.texts(), /Ask more/);
  c.unmount(); await use(null);
});

test("error: a refused ask keeps the panel open with the reason; a failed ask says so on the card", async () => {
  await use(source([], "Follow-up doesn't track this card's workspace, so no agent can answer on the card."));
  const c = await card();
  await c.press(/^More context on Q1$/);
  await c.press(/^Ask the agent/);
  assert.match(c.texts(), /doesn't track this card's workspace/);
  assert.ok(c.all(n => n.props.accessibilityLabel === "What do you want to know?").length, "the words stay for another try");
  c.unmount();
  await use(source([ask({ state: "failed", error: "The agent is gone." })]));
  const failed = await card();
  assert.match(failed.texts(), /The agent is gone\./);
  failed.unmount(); await use(null);
});

test("a fresh card reads the asks once, so an ask made elsewhere shows even without the feed (Paseo 0.15)", async () => {
  const s = source(); await use(s);
  const a = await card(); const b = await card();
  assert.equal(s.reads, 1, "one read for the client, not one per card");
  a.unmount(); b.unmount(); await use(null);
});
