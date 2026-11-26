// Every list pages (invariant pr-scale-lists-batch-not-throw). 2026-11-26, Tom: "in this workspace for example I have
// tons of timeline items and questions, when I click "Show all" in the timeline it lags a bit then makes the whole
// sidebar scroll forever, maybe make it so it shows a page layout with a max amount in each page". The Activity card
// drew every row on Show all, and follow.get / follow.list carried every question and sent batch ever made.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PAGE, boundDone, pageInfo, pageLabel, window } from "../shared/paged";
import { HISTORY_KEPT, activityPage, boundHistory } from "../shared/history";
import { listEntry } from "../shared/list";
import { workspaceSchema } from "../shared/model";
import { bigHistory } from "./support/big-history";

const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));
const big = () => workspaceSchema.parse(bigHistory());

test("pageInfo clamps and labels: '26–50 of 312', a page past the end is the last one", () => {
  assert.deepEqual(pageInfo(312, 1), { page: 1, pages: 13, total: 312, from: 25, to: 50 });
  assert.equal(pageLabel(pageInfo(312, 1)), "26–50 of 312");
  assert.equal(pageLabel(pageInfo(312, 99)), "301–312 of 312");
  assert.equal(pageLabel(pageInfo(0, 3)), "0 of 0");
  assert.equal(pageLabel(pageInfo(26, 1)), "26 of 26");
});

test("window bounds every paged read at PAGE.maxLimit, and says how many are left", () => {
  const items = Array.from({ length: 500 }, (_, i) => i);
  const w = window(items, 480, 1000);
  assert.equal(w.items.length, 20);
  assert.equal(window(items, 0, 1000).items.length, PAGE.maxLimit);
  assert.equal(window(items, 0, 10).more, 490);
});

test("boundDone keeps active items whole and the newest few finished ones, with a count of the rest", () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ n: i, done: i >= 4 }));
  const b = boundDone(items, x => x.done, { newestFirst: (a, b) => b.n - a.n, hint: "pass offset" });
  assert.equal(b.items.filter(x => !x.done).length, 4);
  assert.deepEqual(b.items.filter(x => x.done).map(x => x.n), [295, 296, 297, 298, 299], "newest five, in the list's own order");
  assert.deepEqual(b.done, { total: 296, offset: 0, shown: 5, more: 291, hint: "pass offset" });
});

test("follow.get and follow.list carry live history in full and only the newest settled items", () => {
  const w = big();
  const bounded = boundHistory(w);
  assert.equal(bounded.questions.filter(q => !q.answer).length, 3, "every open question stays");
  assert.equal(bounded.questions.length, 3 + HISTORY_KEPT);
  assert.equal(bounded.batches.length, HISTORY_KEPT);
  assert.ok(bounded.questions.some(q => q.id === "Q172"), "the newest answered one stays");
  assert.ok(!bounded.questions.some(q => q.id === "Q1"), "the oldest goes");
  const full = JSON.stringify(w).length, list = JSON.stringify(listEntry(w)).length, get = JSON.stringify(bounded).length;
  assert.ok(full > 500_000, `the fixture is busy (${full} chars)`);
  assert.ok(get < 120_000, `follow.get stays bounded (${get} chars)`);
  assert.ok(list < 60_000, `follow.list's entry stays bounded (${list} chars)`);
  assert.equal(boundHistory(workspaceSchema.parse(bigHistory({ questions: 10, batches: 10 }))).questions.length, 10, "a small workspace is unchanged");
});

test("an answer not yet delivered, or a question a live task waits on, stays however old", () => {
  const w = big();
  const q1 = { ...w.questions[0], answer: { ...w.questions[0].answer!, delivery: { ...w.questions[0].answer!.delivery, state: "copied" as const } } };
  const q2 = w.questions[1];
  const kept = boundHistory({ ...w, questions: [q1, q2, ...w.questions.slice(2)], obligations: [{ id: "t1", title: "Ship it", status: "blocked", coveredBy: q2.id } as never] });
  assert.ok(kept.questions.some(q => q.id === q1.id) && kept.questions.some(q => q.id === q2.id));
});

test("follow.activity pages the timeline and finds a match on the last page", () => {
  const w = big();
  const first = activityPage(w, { tab: "timeline", offset: 0, limit: PAGE.size });
  assert.equal(first.timeline.length, PAGE.size);
  assert.ok(first.total > 700, `every event counts (${first.total})`);
  const last = activityPage(w, { tab: "timeline", offset: first.total - 3, limit: PAGE.size });
  assert.equal(last.timeline.length, 3);
  const found = activityPage(w, { tab: "questions", query: "zanzibar" });
  assert.deepEqual(found.questions.map(q => q.question.id), ["Q1"], "Q1 sorts last of 175, and search finds it");
  assert.ok(found.counts.timeline >= 2, "its asked and answered rows match in the timeline too");
  assert.ok(found.questions[0].hit?.ranges[0].length, "with the match marked");
});

// The card itself, under the native stand-in (no DOM, Android rules), reading pages from a fake worker.
register("./support/native/hooks.mjs", import.meta.url);
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: Node) => boolean): Node[] } }; act: (f: () => Promise<void> | void) => Promise<void> };
const { rpc, rpcCalls } = await import("./support/native/plugin-client.mjs" as string) as { rpc: { reply: (name: string, input: unknown) => unknown }; rpcCalls: { name: string; input: Record<string, unknown> }[] };
const { ActivityCard } = await import("../client/questions");
const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;

async function card(w = big()) {
  const stored = w;
  const shown = boundHistory(w);
  rpc.reply = (name, input) => name === "follow.activity" ? { ...activityPage(stored, input as never), error: null } : {};
  rpcCalls.length = 0;
  let opened = false;
  const toggle = () => { opened = !opened; };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let r: ReturnType<typeof create>;
  const el = () => createElement(QueryClientProvider, { client }, createElement(ActivityCard, { workspace: shown, theme, compact: true, now: Date.parse("2026-01-03T00:00:00Z"), open: (k: string) => k === "activity" && opened, toggle, onOpenQuestion: () => {} }));
  const orig = console.error; console.error = () => {};
  async function render() { await act(async () => { if (r) (r as unknown as { update(e: unknown): void }).update(el()); else r = create(el()); }); await act(async () => { await new Promise(res => setTimeout(res, 20)); }); }
  await render();
  console.error = orig;
  const text = (n: Node): string => n.children.map(ch => typeof ch === "string" ? ch : text(ch as Node)).join("");
  const rows = () => r!.root.findAll(n => n.type === "Text" && typeof n.props.style === "object" && n.children.some(ch => typeof ch === "string" && /^(Sent|Main agent|Q\d+ ·)/.test(ch as string))).length;
  const press = async (label: string) => { const b = r!.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === "function")[0]; assert.ok(b, `a "${label}" button`); await act(async () => { (b.props.onPress as () => void)(); }); await render(); };
  const labels = () => r!.root.findAll(n => typeof n.props.accessibilityLabel === "string").map(n => n.props.accessibilityLabel as string);
  const texts = () => r!.root.findAll(n => n.type === "Text").map(text);
  return { rows, press, labels, texts, calls: rpcCalls };
}

test("the Activity card draws at most PAGE.preview rows folded and PAGE.size a page, never every row", async () => {
  const c = await card();
  assert.ok(c.rows() <= PAGE.preview, `folded: ${c.rows()} rows`);
  assert.ok(c.texts().some(x => /^Show all \d+$/.test(x)), `Show all names the whole count: ${JSON.stringify(c.texts().slice(0, 30))} calls ${JSON.stringify(c.calls)}`);
  await c.press(c.labels().find(l => /^Show Show all/.test(l))!);
  assert.ok(c.rows() <= PAGE.size && c.rows() > PAGE.preview, `opened: ${c.rows()} rows`);
  assert.ok(c.texts().some(x => /^1–25 of \d+$/.test(x)), "the pager says where it is");
  await c.press("Next page");
  assert.ok(c.texts().some(x => /^26–50 of \d+$/.test(x)), `Next goes to the second page: ${JSON.stringify(c.texts().slice(-6))} ${JSON.stringify(c.calls.slice(-3))}`);
  assert.ok(c.rows() <= PAGE.size);
  assert.ok(c.calls.every(x => x.name !== "follow.activity" || (x.input.limit as number) <= PAGE.size), "every read asks for one page at most");
  await c.press("Show less");
  assert.ok(c.rows() <= PAGE.preview, "Show less folds back");
});

test("PagedRows draws one page of a long list, and Next moves on", async () => {
  const { PagedRows } = await import("../client/paged-list");
  const { Text } = await import("../client/text");
  const items = Array.from({ length: 312 }, (_, i) => `row ${i + 1}`);
  let r: ReturnType<typeof create>;
  const el = () => createElement(PagedRows, { items, theme, compact: true, noun: "rows", row: (x: string) => createElement(Text, { key: x }, x) });
  await act(async () => { r = create(el()); });
  const texts = () => r!.root.findAll(n => n.type === "Text").map(n => n.children.filter(ch => typeof ch === "string").join(""));
  assert.equal(texts().filter(x => x.startsWith("row ")).length, PAGE.size);
  assert.ok(texts().includes("1–25 of 312"));
  const next = r!.root.findAll(n => n.props.accessibilityLabel === "Next page" && typeof n.props.onPress === "function")[0];
  await act(async () => { (next.props.onPress as () => void)(); });
  assert.ok(texts().includes("26–50 of 312"));
  assert.equal(texts().filter(x => x.startsWith("row ")).length, PAGE.size);
  assert.ok(texts().includes("row 26") && !texts().includes("row 1"));
});

/** Lists whose store caps them far below a page's worth of trouble, with the cap that bounds them. */
const BOUNDED: Record<string, string> = {
  "client/linked.tsx": "linked items: at most LIMITS.items (50) a workspace, pruned on insert (shared/linked.ts)",
};

test("every list pages: no 'Show all' or 'Show N more' that draws the whole list, outside the shared pager", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const files = (await readdir("client")).filter(f => /\.tsx?$/.test(f) && f !== "paged-list.tsx");
  const offenders: string[] = [];
  for (const f of files) {
    const src = await readFile(`client/${f}`, "utf8");
    // The Activity card pages on the worker (follow.activity) and draws its own fold row; everything else uses usePagedList.
    for (const m of src.matchAll(/`Show all \$\{|Show \$\{[^}]+\} more|setAll\(true\)|setCap\(/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      if (f === "questions.tsx" && /Show all \$\{d\.total\}/.test(src.split("\n")[line - 1])) continue;
      if (BOUNDED[`client/${f}`]) continue;
      offenders.push(`client/${f}:${line}`);
    }
  }
  assert.deepEqual(offenders, [], "a list that opens to every row: draw it with usePagedList or PagedRows (client/paged-list.tsx)");
});

// 2026-11-26, review: the pager sits under a 25-row page, so after Next the reader landed at the end of the new page.
// A page turn brings the list's top (its card's header) back into view when it had scrolled above the panel.
test("turning a page scrolls the list's card header back into view, and only when it is out of view", async () => {
  const { toListStart, PAGED_TOP } = await import("../client/paged-list");
  type Fake = { parentElement: Fake | null; top: number; attrs: Record<string, string>; scrolled: number; overflow: string; getBoundingClientRect(): { top: number }; getAttribute(n: string): string | null; scrollIntoView(): void };
  const el = (parent: Fake | null, top: number, attrs: Record<string, string> = {}, overflow = "visible"): Fake => ({ parentElement: parent, top, attrs, scrolled: 0, overflow,
    getBoundingClientRect() { return { top: this.top }; }, getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }, scrollIntoView() { this.scrolled++; } });
  const panel = el(null, 100, {}, "auto");
  const card = el(panel, -900, { [PAGED_TOP]: "1" });
  const rows = el(card, -860);
  const pager = el(rows, 700);
  assert.equal(toListStart(pager, e => (e as Fake).overflow), true);
  assert.equal(card.scrolled, 1, "the card (with its header) is what comes back, not the rows under it");
  assert.equal(rows.scrolled, 0);
  card.top = 140;
  assert.equal(toListStart(pager, e => (e as Fake).overflow), false, "a header already in view stays put");
  assert.equal(card.scrolled, 1);
  const loose = el(panel, -50), pager2 = el(loose, 600);
  assert.equal(toListStart(pager2, e => (e as Fake).overflow), true, "a list outside a card comes back by its own top");
  assert.equal(loose.scrolled, 1);
});

test("every Card marks its top for the pager, and its icon never shrinks to a sliver", async () => {
  const { Card } = await import("../client/kit");
  const { Text } = await import("../client/text");
  let r: ReturnType<typeof create>;
  await act(async () => { r = create(createElement(Card, { theme, compact: false, icon: "Activity", title: "Activity", right: createElement(Text, null, "x".repeat(400)) }, null)); });
  const root = r!.root.findAll(n => n.type === "View" && (n.props.dataSet as { pagedTop?: string } | undefined)?.pagedTop !== undefined);
  assert.equal(root.length, 1, "the card carries data-paged-top");
  const iconBox = r!.root.findAll(n => n.type === "View" && (n.props.style as { flexShrink?: number } | undefined)?.flexShrink === 0);
  assert.ok(iconBox.length >= 1, "the header icon sits in a box that does not shrink");
});
