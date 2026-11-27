// every-agent-field-takes-images (AGENTS.md invariant 97) under invariant 36: a pasted image is never dropped silently.
// 2026-11-23, review of PR #302: a question's Retry after a failed send resent the words without the images
// (pending-answers kept only the words); a failed direct send (an agent's or the Overseer's reply box, Home's ask to
// the Overseer) lost its images once the box closed; and a brief card with an answer and a note open drew its one
// image set twice. These render the real components under the native stand-in and read what reached the send.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createElement as ce, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { questionSchema, OTHER, type Question } from "../shared/questions";
import { briefSchema } from "../shared/brief";
import { clock, workspace } from "./fixtures";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any> };
type Rendered = { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => Rendered; act: (f: () => Promise<void> | void) => Promise<void> };
const { QuestionBody } = await import("../client/questions");
const { ReplyBox } = await import("../client/home") as { ReplyBox?: unknown };
const { BriefBody } = await import("../client/brief") as { BriefBody?: unknown };
const { ImageField, useImageAttachments } = await import("../client/image-attach");
const { unsentImages } = await import("../client/unsent-images");
const pending = await import("../client/pending-answers") as typeof import("../client/pending-answers") & { restore?: (p: Record<string, unknown>, now: number) => Record<string, { error?: string; images?: number }> };
const { rpcCalls, rpc } = await import("./support/native/plugin-client.mjs" as string) as { rpcCalls: { name: string; input: Record<string, unknown> }[]; rpc: { reply: (name: string, input: unknown) => unknown } };

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A 1×1 PNG: a real image by its first bytes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const shot = (name: string) => ({ name, mimeType: "image/png", bytes: Math.floor(PNG.length * 3 / 4), read: async () => PNG });
const sentReply = rpc.reply;
const supportOk = (name: string, input: unknown) => name === "follow.image-support" ? { ok: true, provider: "Claude", reason: null } : sentReply(name, input);

async function mount(el: unknown) {
  let r!: Rendered;
  const orig = console.error; console.error = () => {};
  try { await act(() => { r = create(createElement(QueryClientProvider, { client: new QueryClient() }, el)); }); } finally { console.error = orig; }
  const find = (f: (n: Node) => boolean) => r.root.findAll(n => typeof n.type !== "string" && f(n))[0] ?? r.root.findAll(f)[0];
  const press = async (label: RegExp) => { const n = find(x => typeof x.props.onPress === "function" && label.test(String(x.props.accessibilityLabel ?? ""))); assert.ok(n, `a control labelled ${label}`); await act(async () => { await n.props.onPress(); }); };
  const type = async (text: string) => { const n = find(x => typeof x.props.onChangeText === "function"); assert.ok(n, "the field"); await act(() => { n.props.onChangeText(text); }); };
  const fields = () => r.root.findAll(n => n.type === ImageField);
  const model = () => { const f = fields()[0]; assert.ok(f, "the field is drawn inside ImageField"); return f.props.model as { images: unknown[]; add(i: unknown[]): Promise<void> }; };
  const paste = async (...names: string[]) => { await act(async () => { await model().add(names.map(shot)); }); };
  const value = () => find(x => typeof x.props.onChangeText === "function")?.props.value as string;
  const settle = () => act(async () => { await new Promise(res => setTimeout(res, 20)); });
  return { press, type, paste, model, fields, value, settle, unmount: () => act(() => r.unmount()) };
}

const question: Question = questionSchema.parse({
  id: "Q6", title: "Which empty state?", question: "What should the empty list show?", askedBy: "main-agent",
  askedAt: new Date(clock).toISOString(), mode: "stop",
  options: [{ letter: "A", label: "A blank list" }, { letter: "B", label: "A hint" }],
});
const answers = () => rpcCalls.filter(c => c.name === "follow.answer-question").map(c => c.input);

test("a question's Retry after a failed send sends its images again, after the card was closed and opened", async () => {
  rpcCalls.length = 0;
  const w = workspace({ questions: [question] });
  const card = () => createElement(QuestionBody, { workspace: w, question, theme, now: clock });
  rpc.reply = (name, input) => { if (name === "follow.answer-question") throw new Error("Paseo isn't reachable"); return supportOk(name, input); };
  try {
    const first = await mount(card());
    await first.press(/Something else/);
    await first.type("Like this screenshot from staging");
    await first.paste("staging.png");
    await first.press(/^Send your Q6 answer/);
    await first.settle();
    assert.equal((answers()[0]?.images as unknown[] | undefined)?.length, 1, "the first send carried the image");
    await first.unmount();
    rpc.reply = supportOk;
    const again = await mount(card());
    assert.equal(again.model().images.length, 1, "the unsent answer's image is back on the card");
    await again.press(/^Retry sending your Q6 answer/);
    await again.settle();
    const retry = answers().at(-1)!;
    assert.equal(retry.words, "Like this screenshot from staging");
    assert.equal((retry.images as { name: string }[] | undefined)?.map(i => i.name).join(), "staging.png", "Retry sends the image again");
    // Confirmed: the images are dropped; the entry stays overlaid only until this client's copy shows the answer
    // (answering-is-optimistic), so the card never flickers back open.
    assert.equal(pending.pendingAnswer(w.id, question.id)?.confirmed, true, "confirmed");
    assert.equal(unsentImages(pending.answerImagesKey(w.id, question.id)).length, 0, "confirmed: its images aren't kept");
    await again.unmount();
  } finally { rpc.reply = sentReply; pending.clearPendingAnswer(w.id, question.id); }
});

test("after a reload an unsent answer says its images weren't kept, never sends without a word", () => {
  assert.equal(typeof pending.restore, "function", "pending-answers reads entries back through restore()");
  // Past the reload grace (answering-is-optimistic keeps a younger one in flight, hidden, until then).
  const late = clock + pending.RELOAD_GRACE_MS + 1000;
  const out = pending.restore!({ "w/Q6": { choice: OTHER, words: "Like this", at: clock, images: 2 } }, late);
  assert.match(out["w/Q6"]!.error ?? "", /Its 2 images weren't kept; paste them again\./);
  assert.equal(out["w/Q6"]!.images, undefined);
  const plain = pending.restore!({ "w/Q6": { choice: OTHER, words: "Like this", at: clock } }, late);
  assert.equal(plain["w/Q6"]!.error, "Follow-up was reloaded before Paseo confirmed it");
});

test("a reply box's failed send keeps its words and images, even after it closes, and Send sends them again", async () => {
  assert.equal(typeof ReplyBox, "function", "ReplyBox is exported for this test");
  rpcCalls.length = 0; rpc.reply = supportOk;
  const sends: { text: string; images?: unknown[] }[] = [];
  let fail = true;
  const box = () => createElement(ReplyBox, { theme, compact: false, agentName: "the Overseer", target: { kind: "overseer" },
    onSend: async (text: string, images?: unknown[]) => { sends.push({ text, images }); if (fail) throw new Error("Paseo isn't reachable"); } });
  try {
    const first = await mount(box());
    await first.type("Why does the chart look like this?");
    await first.paste("chart.png");
    await first.press(/^Send$/);
    await first.settle();
    assert.equal(sends[0]?.images?.length, 1);
    assert.equal(first.model().images.length, 1, "still attached after the failure");
    await first.unmount();
    const again = await mount(box());
    assert.equal(again.model().images.length, 1, "the box opened again shows the image");
    assert.equal(again.value(), "Why does the chart look like this?", "and the words");
    fail = false;
    await again.press(/^Send$/);
    await again.settle();
    assert.equal(sends.at(-1)?.images?.length, 1, "the resend carries the image");
    assert.equal(again.model().images.length, 0, "sent: the box is empty");
    await again.unmount();
    const after = await mount(box());
    assert.equal(after.model().images.length, 0, "a confirmed send keeps nothing");
    await after.unmount();
  } finally { rpc.reply = sentReply; }
});

test("Home's ask to the Overseer keeps its images until Paseo takes it", async () => {
  const { keepUnsent, dropUnsent, OVERSEER_ASK_KEY } = await import("../client/unsent-images");
  keepUnsent(OVERSEER_ASK_KEY, [{ name: "chart.png", mimeType: "image/png", data: PNG }]);
  let seen = -1;
  function Search() { const m = useImageAttachments({ target: { kind: "overseer" }, keep: OVERSEER_ASK_KEY }); useEffect(() => { seen = m.images.length; }); return null; }
  const s = await mount(createElement(Search, {}));
  assert.equal(seen, 1, "Home's search mounted again shows the unsent ask's image");
  await s.unmount(); dropUnsent(OVERSEER_ASK_KEY);
  const home = readFileSync("client/home.tsx", "utf8");
  const ask = home.slice(home.indexOf("keepUnsent(OVERSEER_ASK_KEY"), home.indexOf("askOverseer(item.ask") + 200);
  assert.match(ask, /keepUnsent\(OVERSEER_ASK_KEY, uploads\);\s*try \{ await deps\.sources\.extras\.askOverseer\(item\.ask, uploads\); dropUnsent\(OVERSEER_ASK_KEY\);/,
    "kept before the ask, dropped only after Paseo took it");
  assert.match(readFileSync("client/home-chrome.tsx", "utf8"), /useImageAttachments\(\{ target: askOn \? \{ kind: "overseer" \} : null, keep: OVERSEER_ASK_KEY \}\)/);
});

test("a brief card with an answer and a note open draws its images once", async () => {
  assert.equal(typeof BriefBody, "function", "BriefBody is exported for this test");
  const b = briefSchema.parse({
    id: "brief:t1", source: "agent", kind: "decision", ask: "Two choices for the export", at: new Date(clock).toISOString(), sourceLine: "main agent",
    decisions: [
      { id: "D1", question: "Which format?", options: [{ letter: "A", label: "CSV" }, { letter: "B", label: "JSON" }] },
      { id: "D2", question: "Which delimiter?", options: [{ letter: "A", label: "Comma" }, { letter: "B", label: "Tab" }] },
    ],
  });
  function Card() {
    const img = useImageAttachments({ target: null });
    return createElement(BriefBody, { b, c: colors, compact: false, tight: false, embedded: false, height: 800, mode: "send", picks: { D1: OTHER, D2: "A" }, onPick: () => {}, busy: null,
      words: { D1: "Parquet" }, notes: { D2: "Only for the admin export" }, notesOpen: { D2: "1" }, img });
  }
  const card = await mount(createElement(Card, {}));
  const fields = card.fields();
  assert.equal(fields.length, 2, "both fields take images");
  assert.equal(fields.filter(f => f.props.row !== false).length, 1, "one of them draws the card's thumbnails");
  assert.equal(fields.at(-1)!.props.row, true, "the last open field draws them");
  await card.unmount();
});
