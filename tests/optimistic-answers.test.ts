// answering-is-optimistic (AGENTS.md invariant 138). 2026-11-27, the developer on a phone: "When answering a question,
// it sometimes takes a couple of moments for it to register it seems, I want the ux to be instant and optimistic, if
// the send fails handle it well." After Send on a Something else answer in the panel the card stayed exactly as it was
// (the option picked, the words in the field) with only a "Sending to the main agent" toast, until the RPC replied and
// the follow.get refetch landed: two round trips over the relay. Root cause: QuestionBody kept the answer in
// pending-answers but nothing read it except the pill, so every other surface waited for the server's copy. Now every
// surface reads its workspaces through one overlay (shared/optimistic-answers.ts), applied by the shared stores.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { questionSchema, OTHER, isOpen, type Question } from "../shared/questions";
import { developerAnswer } from "../server/questions";
import { withPendingAnswers, settledAnswers, withSettledBrief, type InFlightAnswer } from "../shared/optimistic-answers";
import { activeNeeds, needsYou } from "../shared/attention";
import { buildHome, homeCounts } from "../shared/home";
import { listEntry, type ListWorkspace } from "../shared/list";
import type { InboxRow } from "../shared/inbox";
import type { Workspace } from "../shared/model";
import { clock, workspace } from "./fixtures";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void }; act: (f: () => Promise<void> | void) => Promise<void> };
const { QuestionBody } = await import("../client/questions");
const pending = await import("../client/pending-answers");
const { createLiveStore } = await import("../client/live");
const { rpcCalls, rpc } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[]; rpc: { reply: (name: string, input: unknown) => unknown } };

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Fictional: acme's billing workspace asks which retry policy to use.
const question: Question = questionSchema.parse({
  id: "Q5", title: "Which retry policy?", question: "How should failed charges retry?", askedBy: "main-agent",
  askedAt: new Date(clock).toISOString(), mode: "stop", recommended: "A",
  options: [{ letter: "A", label: "Retry once after a day" }, { letter: "B", label: "Retry hourly" }, { letter: "C", label: "Never retry" }],
});
const typed = "Retry twice, then email the customer";
const ws = (patch: Partial<Workspace> = {}) => workspace({ id: "w-acme", mainAgentId: "main-agent", questions: [question], ...patch });
const key = pending.pendingKey;
const entry = (p: Partial<InFlightAnswer> = {}): Record<string, InFlightAnswer> => ({ [key("w-acme", "Q5")]: { choice: OTHER, words: typed, at: clock, ...p } });
const row = (patch: Partial<InboxRow> = {}): InboxRow => ({ agentId: "main-agent", workspaceId: "w-acme", title: "Main", workspaceTitle: "acme billing", multiRoot: false, status: "idle", delegatedFrom: null, resumesAt: null,
  lastActivityAt: new Date(clock).toISOString(), needs: { reasons: [{ reason: "finished", at: new Date(clock).toISOString(), detail: "Asks Q5", dedupeKey: "finished" }], since: new Date(clock).toISOString() },
  snooze: null, signedOffAt: null, undoable: false, seq: 1, muteTurn: false, enable_finish_flags: true,
  brief: { kind: "decision", source: "agent", state: "open", ask: "Which retry policy?", questionIds: ["Q5"], at: new Date(clock).toISOString() }, ...patch });
/** Every count a surface draws for one workspace: the panel's block and pill (needsYou), the header dot (activeNeeds), Home and the sidebar (homeCounts). */
const counts = (w: Workspace) => ({ needs: needsYou(w, clock).length, dot: activeNeeds(w).length, home: homeCounts(buildHome({ rows: [row()], tracked: [w], paseo: [], now: clock })).needs, open: w.questions.filter(isOpen).length });
/** The server's copy after the same answer: developerAnswer is what follow.answer-question records. */
const recorded = (action: "send" | "copy" | "chat") => { const w = structuredClone(ws()); developerAnswer(w, "Q5", OTHER, typed, action, clock); return w; };

test("an answer in flight reads as answered at once, exactly as the server records it", () => {
  for (const action of ["send", "copy", "chat"] as const) {
    const w = withPendingAnswers(ws(), entry(action === "send" ? {} : { action }), key);
    const q = w.questions[0];
    const server = recorded(action).questions[0];
    assert.equal(isOpen(q), false, `${action}: not open`);
    assert.equal(q.answer?.delivery.state, server.answer?.delivery.state, `${action}: the server's delivery state`);
    assert.deepEqual([q.answer?.choice, q.answer?.words, q.answer?.by], [server.answer?.choice, server.answer?.words, server.answer?.by]);
    // Every surface's count agrees with the server's copy, so nothing moves when it lands.
    assert.deepEqual(counts(w), counts(recorded(action)), `${action}: counts match the server's copy`);
  }
});

test("counts drop on every surface at once, and a failure brings them back", () => {
  const before = counts(ws());
  assert.ok(before.needs >= 1 && before.dot >= 1 && before.home >= 1 && before.open === 1, "the open question counts everywhere");
  const sent = counts(withPendingAnswers(ws(), entry(), key));
  assert.deepEqual(sent, { needs: 0, dot: 0, home: counts(recorded("send")).home, open: 0 }, "Send: out of Needs you and the dot; Home and the sidebar as the server's copy will say");
  const failed = withPendingAnswers(ws(), entry({ error: "Paseo is offline" }), key);
  assert.deepEqual(counts(failed), before, "a failed send: open again, every count back");
  const w = ws(); assert.equal(withPendingAnswers(w, {}, key), w, "nothing in flight: the same object (identity caches hold)");
});

test("Copy and Put in chat leave the answer waiting to be sent, as invariant 20 says", () => {
  for (const action of ["copy", "chat"] as const) {
    const items = needsYou(withPendingAnswers(ws(), entry({ action }), key), clock);
    assert.deepEqual(items.map(i => i.kind), ["answer"], `${action}: "Your Q5 answer isn't sent yet"`);
  }
  // Send on that waiting answer: on its way at once.
  const copied = recorded("copy");
  const sending = withPendingAnswers(copied, entry(), key);
  assert.equal(sending.questions[0].answer?.delivery.state, "sending");
  assert.deepEqual(needsYou(sending, clock), [], "it leaves Needs you");
});

test("the brief that asked the question resolves with it, as the worker resolves it", () => {
  const answered = withPendingAnswers(ws(), entry(), key);
  assert.equal(withSettledBrief(row(), answered).brief?.state, "answered");
  assert.equal(withSettledBrief(row(), ws()).brief?.state, "open", "still open while the question is");
  const r = row(); assert.equal(withSettledBrief(r, undefined), r);
});

test("the server's copy settles what it has: recorded, answered or withdrawn elsewhere", () => {
  const p = entry();
  assert.deepEqual(settledAnswers(ws(), p, key), [], "still open on the server: keep it");
  assert.deepEqual(settledAnswers(recorded("send"), p, key), [key("w-acme", "Q5")], "recorded");
  assert.deepEqual(settledAnswers(ws({ questions: [{ ...question, closed: { at: new Date(clock).toISOString(), reason: "Moved on", by: null } }] }), entry({ error: "x" }), key), [key("w-acme", "Q5")], "withdrawn meanwhile: no error left to show");
  assert.deepEqual(settledAnswers(recorded("copy"), p, key), [], "a Send over a copied answer waits until the server shows it sending");
});

// ---------- the client stores: one overlay for every surface ----------

function fakeClient(list: ListWorkspace[]) {
  return { rpc: async () => ({ full: true, workspaces: list, revision: 1 }) } as never;
}

test("the shared live store hides the question the moment the answer is kept, and settles from the server's copy", async () => {
  const store = createLiveStore(fakeClient([listEntry(ws()) as ListWorkspace]));
  try {
    await new Promise(res => setTimeout(res, 10));
    assert.equal(store.get("w-acme")?.questions.filter(isOpen).length, 1);
    const v = store.version();
    pending.setPendingAnswer("w-acme", "Q5", { choice: OTHER, words: typed });
    assert.ok(store.version() > v, "every subscribed surface re-renders");
    assert.equal(store.get("w-acme")?.questions.filter(isOpen).length, 0, "hidden at once, before any reply");
    assert.equal(store.all()[0].questions[0].answer?.delivery.state, "sending");
    pending.failPendingAnswer("w-acme", "Q5", "Paseo is offline");
    assert.equal(store.get("w-acme")?.questions.filter(isOpen).length, 1, "back where it was on failure");
    // The server's copy arrives with Q5 answered (another device): the kept copy has nothing left to do.
    store.accept({ ...recorded("send"), updatedAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(pending.pendingAnswer("w-acme", "Q5"), undefined, "settled from the server's copy");
  } finally { store.stop(); pending.clearPendingAnswer("w-acme", "Q5"); }
});

// ---------- the card: hidden at once, and back with everything on failure ----------

async function card(w: Workspace, props: Record<string, unknown> = {}) {
  const client = new QueryClient();
  let r!: ReturnType<typeof create>;
  const orig = console.error; console.error = () => {};
  try { await act(() => { r = create(createElement(QueryClientProvider, { client }, createElement(QuestionBody, { workspace: w, question: w.questions[0], theme, now: clock, ...props }))); }); }
  finally { console.error = orig; }
  const all = (f: (n: Node) => boolean) => r.root.findAll(n => f(n));
  const find = (f: (n: Node) => boolean) => r.root.findAll(n => typeof n.type !== "string" && f(n))[0] ?? r.root.findAll(f)[0];
  const press = async (label: RegExp) => { const n = find(x => typeof x.props.onPress === "function" && label.test(String(x.props.accessibilityLabel ?? ""))); assert.ok(n, `a control labelled ${label}`); await act(() => { n.props.onPress(); }); };
  const type = async (text: string) => { const n = find(x => typeof x.props.onChangeText === "function"); assert.ok(n, "the answer field"); await act(() => { n.props.onChangeText(text); }); };
  const field = () => find(x => typeof x.props.onChangeText === "function")?.props.value as string | undefined;
  const texts = () => all(n => typeof n.props.children === "string" || Array.isArray(n.props.children)).flatMap(n => [n.props.children].flat()).filter((x): x is string => typeof x === "string").join(" ");
  const selected = () => all(n => n.props.accessibilityRole === "radio" && n.props["aria-checked"] === true).map(n => String(n.props.accessibilityLabel));
  const settle = () => act(async () => { await new Promise(res => setTimeout(res, 20)); });
  return { press, type, field, texts, selected, settle, unmount: () => r.unmount() };
}

test("Send hides the question before the server replies; a failure restores the pick, the words and the reason with Retry", async () => {
  rpcCalls.length = 0;
  let release!: (v: unknown) => void;
  const reply = rpc.reply;
  // The RPC hangs until released: the round trip the developer used to wait for.
  rpc.reply = () => new Promise((_, reject) => { release = reject; });
  const w = ws();
  try {
    const c = await card(w);
    await c.press(/Something else/);
    await c.type(typed);
    await c.press(/^Send your Q5 answer/);
    // In flight: the stores read it answered (every surface drops it) while the RPC is still out.
    assert.equal(pending.pendingAnswer(w.id, "Q5")?.error, undefined, "in flight");
    assert.equal(withPendingAnswers(w, pending.pendingAnswers(), key).questions.filter(isOpen).length, 0, "hidden at once");
    c.unmount();
    release(new Error("Paseo is offline"));
    await c.settle();
    const kept = pending.pendingAnswer(w.id, "Q5");
    assert.deepEqual([kept?.choice, kept?.words, kept?.error], [OTHER, typed, "Paseo is offline"], "kept with the reason");
    assert.equal(withPendingAnswers(w, pending.pendingAnswers(), key).questions.filter(isOpen).length, 1, "open again");
    // The surface draws it again (a new mount, as Needs you does): the pick, the words, the reason and Retry.
    const back = await card(w);
    assert.equal(back.field(), typed, "the words are back in the field");
    assert.ok(back.selected().some(l => /Something else/.test(l)), "Something else is still picked");
    assert.match(back.texts(), /Not sent ·\s+Paseo is offline/);
    // Retry sends the same answer, hidden again while it goes.
    rpc.reply = () => new Promise(() => undefined);
    await back.press(/^Retry sending your Q5 answer/);
    assert.equal(pending.pendingAnswer(w.id, "Q5")?.error, undefined, "in flight again: hidden");
    assert.deepEqual(rpcCalls.filter(x => x.name === "follow.answer-question").map(x => [x.input.choice, x.input.words]).at(-1), [OTHER, typed]);
    back.unmount();
  } finally { rpc.reply = reply; pending.clearPendingAnswer(w.id, "Q5"); }
});

test("a lettered pick with a note comes back with both after a failure", async () => {
  const reply = rpc.reply;
  rpc.reply = () => Promise.reject(new Error("Timed out"));
  const w = ws();
  try {
    const c = await card(w);
    await c.press(/^B\b|Retry hourly/);
    await c.press(/^Add a note/);
    await c.type("Only for card_declined");
    await c.press(/^Send your Q5 answer/);
    await c.settle();
    c.unmount();
    const back = await card(w);
    assert.ok(back.selected().some(l => /^B\./.test(l)), "B is still picked");
    assert.equal(back.field(), "Only for card_declined", "the note is back, open");
    back.unmount();
  } finally { rpc.reply = reply; pending.clearPendingAnswer(w.id, "Q5"); }
});

test("a confirmed answer stays hidden until the client's copy shows it, so the card never flickers back", async () => {
  const w = ws();
  try {
    const c = await card(w);
    await c.press(/^B\b|Retry hourly/);
    await c.press(/^Send your Q5 answer/);
    await c.settle();
    c.unmount();
    assert.equal(pending.pendingAnswer(w.id, "Q5")?.confirmed, true, "the reply confirmed it");
    assert.equal(withPendingAnswers(w, pending.pendingAnswers(), key).questions.filter(isOpen).length, 0, "still hidden on the old copy");
  } finally { pending.clearPendingAnswer(w.id, "Q5"); }
});
