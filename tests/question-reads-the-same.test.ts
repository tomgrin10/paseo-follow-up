// one-answer-flow-for-every-question (AGENTS.md invariant 41), 2026-11-27 line. The developer: "when the question pops
// up in the timeline, it doesn't show the links, in the sidebar it does, so it looks weird." The panel's Needs you card
// (QuestionBody) drew the question's note, links, PR line, task line and More context; the chat timeline's brief card
// for a needs_you pointing at those questions (BriefBody) drew only each question's text and options, so a question
// saying "(page below)" had no page below, open or as "Replaced by a newer card · Hide original". Root cause: the
// context was inline in QuestionBody. Both now draw QuestionContextBlock (client/question-context.tsx). These render
// the real components under the native stand-in and compare what each shows.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { register } from "node:module";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { questionSchema, type Question } from "../shared/questions";
import { briefSchema, decisionQuestion } from "../shared/brief";
import { clock, workspace } from "./fixtures";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
type Node = { type: unknown; props: Record<string, any>; children: unknown[] };
type Rendered = { root: { findAll(f: (n: Node) => boolean): Node[] }; unmount(): void };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => Rendered; act: (f: () => Promise<void> | void) => Promise<void> };
const { QuestionBody } = await import("../client/questions");
const { BriefBody } = await import("../client/brief");
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ROOT = join(import.meta.dirname, "..");

const at = new Date(clock).toISOString();
const ask = (id: string, patch: Record<string, unknown> = {}): Question => questionSchema.parse({
  id, title: `Sidebar layout ${id}`, question: `Which sidebar layout should ship? (page below)`, askedBy: "main-agent", askedAt: at, mode: "stop",
  background: "My review adds: the compact layout hides the badge on phones.",
  links: [{ label: "Sidebar design page", url: "https://claude.ai/artifact/acme-sidebar" }],
  options: [{ letter: "A", label: "Compact" }, { letter: "B", label: "Roomy" }], ...patch,
});

function texts(r: Rendered): string {
  const out: string[] = [];
  const walk = (n: unknown) => { if (typeof n === "string") out.push(n); else if (n && typeof n === "object" && "children" in n) for (const c of (n as Node).children ?? []) walk(c); };
  for (const n of r.root.findAll(x => x.type === "Text" || (typeof x.type === "string" && /text/i.test(x.type)))) walk(n);
  return out.join(" ");
}
async function mount(el: unknown): Promise<Rendered> {
  let r!: Rendered;
  const orig = console.error; console.error = () => {};
  try { await act(() => { r = create(createElement(QueryClientProvider, { client: new QueryClient() }, el)); }); } finally { console.error = orig; }
  return r;
}

test("a decision is the tracked question it points at, and only that", () => {
  const b = briefSchema.parse({ id: "brief:t1", source: "agent", kind: "decision", ask: "Three decisions", at, sourceLine: "main agent", questionIds: ["Q181"], decisions: [{ id: "Q181", question: "?", options: [] }, { id: "D2", question: "?", options: [] }] });
  const qs = [ask("Q181"), ask("Q999")];
  assert.equal(decisionQuestion(b, "Q181", qs)?.id, "Q181");
  assert.equal(decisionQuestion(b, "D2", qs), null, "a decision with no tracked question has no question context");
  assert.equal(decisionQuestion(b, "Q999", qs), null, "a question the brief doesn't point at isn't drawn");
  assert.equal(decisionQuestion(b, "Q181", undefined), null);
});

test("the timeline card shows each question's note and links, as the panel's card does", async () => {
  const questions = [ask("Q181"), ask("Q180", { links: [{ label: "Badge spec", url: "https://example.com/badge" }] }), ask("Q179")];
  const w = workspace({ questions });
  const b = briefSchema.parse({ id: "brief:t1", source: "agent", kind: "decision", ask: "Three sidebar decisions", at, sourceLine: "main agent", questionIds: questions.map(q => q.id),
    decisions: questions.map(q => ({ id: q.id, question: q.question, options: q.options })) });
  const panel = await mount(createElement(QuestionBody, { workspace: w, question: questions[0], theme, compact: false, now: clock }));
  const shown = texts(panel);
  assert.match(shown, /Sidebar design page/, "the panel's card shows the link");
  assert.match(shown, /My review adds/, "and the note");
  panel.unmount();
  for (const mode of ["select", "readonly"] as const) {
    const card = await mount(createElement(BriefBody, { b, c: colors, compact: false, tight: false, embedded: false, height: 800, mode, picks: {}, onPick: () => {}, busy: null, workspace: w }));
    const t = texts(card);
    assert.equal(t.match(/Sidebar design page/g)?.length, 2, `${mode}: Q181's and Q179's link`);
    assert.match(t, /Badge spec/, `${mode}: Q180's own link`);
    assert.equal(t.match(/My review adds/g)?.length, 3, `${mode}: each question's note`);
    card.unmount();
  }
});

test("both cards draw the one context block; neither draws a question's links itself", async () => {
  for (const f of ["client/questions.tsx", "client/brief.tsx"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    assert.match(src, /<QuestionContextBlock /, `${f} draws QuestionContextBlock`);
    assert.doesNotMatch(src, /q\.links\?*\.map|q\.background &&/, `${f} draws no question context of its own`);
  }
  // The past card ("Show full question", "Hide original") passes the workspace on, so its copy shows the links too.
  const brief = await readFile(join(ROOT, "client/brief.tsx"), "utf8");
  assert.match(brief, /mode="readonly"[^\n]*workspace=\{workspace\}/);
});
