// client-renders-under-native-rules (AGENTS.md invariant 51). 2026-11-18, Tom on 2.2.0-beta.4, in the Paseo
// phone app: tapping More context in Catch up crashed the whole app. Every render and test ran on react-native-web,
// which accepts what the phone's React Native rejects. These render the phone paths under a strict native stand-in
// (tests/support/native: no DOM, Platform android, a host view throws on text outside <Text> and on an
// accessibilityRole Android's view manager rejects), through react-test-renderer.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement as ce } from "react";
const createElement = (type: unknown, props: unknown, ...kids: unknown[]) => ce(type as never, props as never, ...(kids as never[]));

register("./support/native/hooks.mjs", import.meta.url);
// Untyped on purpose: react-test-renderer ships no types, and the stand-in is plain JavaScript.
const { create, act } = await import("react-test-renderer" as string) as { create: (el: unknown) => { root: { findAll(f: (n: { type: unknown; props: Record<string, unknown> }) => boolean): { props: Record<string, unknown> }[] } }; act: (f: () => Promise<void>) => Promise<void> };
const { MoveResult, MorePanel, ContextAnswer, Finished, KeysSheet } = await import("../client/catch-up");
const { QuestionMoreContext, setContextSource } = await import("../client/more-context");
const { ANDROID_ROLES } = await import("./support/native/react-native.mjs" as string) as { ANDROID_ROLES: Set<string> };

const colors = new Proxy({}, { get: () => "#888888" });
const theme = new Proxy({ colors }, { get: (t, k) => (k in t ? t[k as keyof typeof t] : colors) }) as never;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(el: unknown) {
  let r: ReturnType<typeof create> | undefined; let error: unknown = null;
  const orig = console.error; console.error = () => {};
  try { await act(async () => { r = create(el); }); } catch (e) { error = e; } finally { console.error = orig; }
  return { r, error };
}

test("the stand-in reads Android's own role list and rejects what Android rejects", () => {
  assert.ok(ANDROID_ROLES.has("button") && ANDROID_ROLES.has("radiogroup") && !ANDROID_ROLES.has("dialog"));
});

test("More context on a phone: the sheet (MoveResult) with its panel renders under the phone's rules", async () => {
  const { r, error } = await render(createElement(MoveResult, { place: "sheet", theme, label: "More context" },
    createElement(MorePanel, { theme, compact: true, onClose: () => {}, onAsk: async () => {} })));
  assert.equal(error, null, `crashed on a phone: ${(error as Error)?.message}`);
  const sheet = r!.root.findAll(n => n.props.accessibilityLabel === "More context" && typeof n.type === "string")[0];
  assert.ok(sheet, "the sheet is on screen");
  assert.equal(sheet.props.role, "dialog", "a dialog by the ARIA role, which Android parses leniently");
  assert.ok(r!.root.findAll(n => n.props.accessibilityLabel === "What do you want to know?").length, "the ask box");
});

test("Later on a phone: the same sheet renders its choices under the phone's rules", async () => {
  const { error } = await render(createElement(MoveResult, { place: "sheet", theme, label: "Later" },
    createElement("View", { accessibilityRole: "menu", accessibilityLabel: "Later" })));
  assert.equal(error, null, `crashed on a phone: ${(error as Error)?.message}`);
});

test("the rest of Catch up that a phone shows renders under the phone's rules: the end, every context answer", async () => {
  const stats = { done: 3, skipped: 2, later: 1, gone: 1, waiting: 1 };
  for (const [name, el] of [
    ["the end with cards left", createElement(Finished, { theme, compact: true, stats, empty: false, onHome: () => {}, onSkipped: () => {} })],
    ["all caught up", createElement(Finished, { theme, compact: true, stats: { done: 2, skipped: 0, later: 0, gone: 0, waiting: 0 }, empty: false, onHome: () => {}, onSkipped: () => {} })],
    ["nothing needs you", createElement(Finished, { theme, compact: true, stats: { done: 0, skipped: 0, later: 0, gone: 0, waiting: 0 }, empty: true, onHome: () => {}, onSkipped: () => {} })],
    ["the keys sheet", createElement(KeysSheet, { theme, onClose: () => {} })],
    ...(["asking", "answered", "chat", "failed"] as const).flatMap(state => (["agent", "overseer"] as const).map(target => [`a context ask, ${target}, ${state}`,
      createElement(ContextAnswer, { theme, compact: true, waiting: state === "asking", agent: "acme-agent", openChat: () => {}, openAgent: () => {},
        request: { id: "r1", workspaceId: "w1", agentId: "a1", cardKey: "agent:a1|Q1", card: "Q1 · Retry declined cards?", ask: "I don't get it. What is this about?", target, state, askedOf: "a1", askedAt: 1, answer: state === "answered" ? "**Retry** once after a day." : undefined, error: state === "failed" ? "The agent is gone." : undefined } as never })])),
  ] as const) {
    const { error } = await render(el as never);
    assert.equal(error, null, `${name} crashed on a phone: ${(error as Error)?.message}`);
  }
});

test("More context on a question outside Catch up (the panel, Home, the pill on a phone) renders under the phone's rules", async () => {
  const ask = (state: string) => ({ id: "r1", workspaceId: "w1", agentId: "a1", cardKey: "ws:w1|Q1", card: "Q1 · Retry declined cards?", ask: "I don't get it.", target: "agent", state, askedOf: "a1", askedAt: "2026-01-01T10:00:00Z", answer: state === "answered" ? "Retry once." : null, error: state === "failed" ? "The agent is gone." : null });
  for (const requests of [[], ...["asking", "answered", "chat", "failed"].map(s => [ask(s)])]) {
    await act(async () => { setContextSource({ context: () => requests as never, subscribe: () => () => {}, askContext: async () => ({ request: ask("asking") as never }) }); });
    const { r, error } = await render(createElement(QuestionMoreContext, { workspace: { id: "w1", mainAgentId: "a1" }, question: { id: "Q1", title: "Retry declined cards?", askedBy: "a1" }, theme, compact: true, openAgent: () => {} }));
    assert.equal(error, null, `crashed on a phone (${requests[0]?.state ?? "idle"}): ${(error as Error)?.message}`);
    const link = r!.root.findAll(n => n.props.accessibilityLabel === "More context on Q1" && typeof n.props.onPress === "function")[0];
    if (link) { let opened: unknown = null; try { await act(async () => { (link.props.onPress as () => void)(); }); } catch (e) { opened = e; } assert.equal(opened, null, "its sheet opens on a phone"); }
  }
  await act(async () => { setContextSource(null); });
});

// Your questions (docs/needs-you.md#your-questions): the card the panel and Home draw, its history sheet, and Catch up's
// answer card, on a phone. Every state the card draws: an answer, one from its chat, one in its chat, a failure, asking.
test("Your questions on a phone renders under the phone's rules: the card in every state, Reply, the history", async () => {
  const { YourQuestionsCard, QuestionHistory, AnswerActions, AnswerView, ReplyForm } = await import("../client/your-questions");
  const q = (id: string, state: string, extra: Record<string, unknown> = {}) => ({ id, workspaceId: "w1", agentId: "a1", cardKey: null, card: "", target: "agent", ask: `Why does ${id} retry?`, state, askedOf: "a1",
    askedAt: "2026-11-26T10:00:00Z", settledAt: state === "asking" ? null : "2026-11-26T10:04:00Z", deliveredAt: "2026-11-26T10:00:05Z", answer: state === "answered" || id === "q2" ? "Because the gateway retries for 60 s." : null,
    error: state === "failed" ? "The agent's chat is gone." : null, by: "developer", via: "field", parentId: null, readAt: null, done: null, task: null, ...extra });
  const requests = [q("q0", "answered", { readAt: "2026-11-26T09:00:00Z", task: { id: "T1", at: "2026-11-26T09:00:00Z", by: "developer" } }), q("q1", "answered"), q("q2", "chat"), q("q3", "chat"), q("q4", "failed"), q("q5", "asking"), q("q6", "asking", { parentId: "q1" })];
  const calls: unknown[] = [];
  await act(async () => { setContextSource({ context: () => requests as never, subscribe: () => () => {}, askContext: async () => ({ request: requests[5] as never }), questionAction: async (input: unknown) => { calls.push(input); return { request: requests[1] as never }; } }); });
  const card = await render(createElement(YourQuestionsCard, { workspaceId: "w1", mainAgentId: "a1", theme, compact: true, openAgent: () => {} }));
  assert.equal(card.error, null, `the card crashed on a phone: ${(card.error as Error)?.message}`);
  // Host views only: a composite component carries the same label as the view it draws.
  const labels = card.r!.root.findAll(n => typeof n.type === "string" && typeof n.props.accessibilityLabel === "string").map(n => n.props.accessibilityLabel as string);
  try {
  assert.ok(labels.includes("Ask the main agent"), "the ask field");
  assert.ok(labels.filter(l => l === "Done").length >= 4, "Done on every unread answer");
  assert.equal(labels.filter(l => l === "Make a task").length, 2, "Make a task only where there is an answer (q1, q2)");
  assert.ok(labels.some(l => l.startsWith("Withdraw")), "Withdraw on a question still asking");
  // Done reaches the one request.
  const done = card.r!.root.findAll(n => n.props.accessibilityLabel === "Done" && typeof n.props.onPress === "function")[0];
  await act(async () => { (done.props.onPress as () => void)(); });
  assert.deepEqual(calls[0], { id: "q4", action: "done" }, "the newest unread answer comes first");
  } finally {
    // The card keeps a clock (useNow): unmount it, so the test process can end.
    await act(async () => { (card.r as unknown as { unmount(): void }).unmount(); });
  }
  for (const [name, el] of [
    ["the history (its sheet's body)", createElement(QuestionHistory, { workspaceId: "w1", theme, compact: true })],
    ["Reply's field", createElement(ReplyForm, { r: requests[1], theme, compact: true, onSent: () => {}, onCancel: () => {} })],
    ["Catch up's answer card", createElement(AnswerView, { r: requests[1], theme, compact: true, now: Date.parse("2026-11-26T10:10:00Z"), big: true })],
    ["Catch up's thumb bar", createElement(AnswerActions, { r: requests[1], theme, compact: true, bar: true, keys: true, busy: null, onDone: () => {}, onReply: () => {}, onTask: () => {}, onAskAgain: () => {}, openChat: () => {} })],
  ] as const) {
    const { r, error } = await render(el as never);
    await act(async () => { (r as unknown as { unmount(): void } | undefined)?.unmount(); });
    assert.equal(error, null, `${name} crashed on a phone: ${(error as Error)?.message}`);
  }
  await act(async () => { setContextSource(null); });
});

test("the PR stats page on a phone renders under the phone's rules: the leaderboard, its empty period and a person", async () => {
  const { Leaderboard, PersonView } = await import("../client/pr-stats");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const sum = (n: number, median: number | null) => ({ n, median, p75: median });
  const row = (login: string, opened: number) => ({ login, opened, openedStacks: opened, merged: opened - 1, wait: sum(opened, opened * 3600), reviews: 4, reviewStacks: 4, turnaround: sum(2, 3600) });
  const team = { opened: 9, openedStacks: 7, merged: 6, wait: sum(9, 7200), timeToMerge: sum(0, null), reviewToMerge: sum(0, null), waitingNow: 1, reviews: 8, mergedWithoutReview: 0, deletedUsers: 0, bots: 0, sizes: {} };
  const out = (people: unknown[]) => ({ repo: "example/app", repos: [{ repo: "example/app", state: "on" }, { repo: "example/web", state: "paused" }], period: "week", range: { start: 1_767_996_000, end: 1_768_118_400 }, clock: "calendar", timeZone: "Africa/Cairo", hours: { days: [0, 1, 2, 3, 4], from: 540, to: 1080 },
    model: { team, people, waiting: [], stale: 0 }, person: { login: "alice", row: people[0] ?? null, prs: [{ number: 412, url: "https://github.com/example/app/pull/412", title: "Add audit events", state: "M", created: 1, wait: 3600, waiting: false, firstResponder: "bob", merged: 2, size: "S" }], reviewed: [{ number: 410, url: "https://github.com/example/app/pull/410", author: "bob", title: "Split the migration", at: 1_768_000_000 }] },
    sync: { records: 120, coveredTo: 1_760_000_000, backfillDone: false, coversPeriod: false, lastSyncAt: 1_768_118_000, waiting: { reason: "budget", until: null }, error: null, cappedTo: null }, teamNotice: null, empty: null });
  const props = { theme, compact: true, now: 1_768_118_400, period: "week", sort: "opened", onSort: () => {}, onPeriod: () => {}, onRepo: () => {}, onPerson: () => {} };
  for (const [name, el] of [
    ["the leaderboard", createElement(Leaderboard, { ...props, out: out([row("alice", 5), row("bob", 3), row("carol", 1)]) })],
    ["an empty period", createElement(Leaderboard, { ...props, out: out([]) })],
    ["one person", createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Leaderboard, { ...props, out: out([row("alice", 5)]) }))],
    ["a person's screen", createElement(PersonView, { theme, compact: true, out: out([row("alice", 5)]), login: "alice" })],
  ] as const) {
    const { error } = await render(el as never);
    assert.equal(error, null, `${name} crashed on a phone: ${(error as Error)?.message}`);
  }
});

// every-agent-field-takes-images: the plugin client has no image picker for plugin fields, so a phone draws no image
// control and keeps no space; the fields around the one component render as before.
test("pasted images on a phone: the component draws nothing, and the fields it wraps still render", async () => {
  const { ImageField, ImageAttachmentsRow, IMAGES_ON } = await import("../client/image-attach");
  assert.equal(IMAGES_ON, false, "no paste or drop on a phone");
  const model = { images: [{ id: "i1", name: "acme.png", mimeType: "image/png", bytes: 10, data: "AAAA", uri: "data:image/png;base64,AAAA" }], refusal: "6 images is the most one message takes.", blocked: null,
    add: async () => {}, refuse: () => {}, remove: () => {}, clear: () => {}, uploads: () => undefined, target: null };
  const row = await render(createElement(ImageAttachmentsRow, { model, theme, compact: true }));
  assert.equal(row.error, null);
  assert.equal(row.r!.root.findAll(n => typeof n.type === "string").length, 0, "no thumbnail, no refusal line, no empty space");
  const field = await render(createElement(ImageField, { model, theme, compact: true }, createElement("TextInput", { accessibilityLabel: "Reply to Dana" })));
  assert.equal(field.error, null, `crashed on a phone: ${(field.error as Error)?.message}`);
  assert.ok(field.r!.root.findAll(n => n.props.accessibilityLabel === "Reply to Dana").length, "the field itself");
  assert.equal(field.r!.root.findAll(n => n.props.accessibilityLabel === "Remove acme.png").length, 0);
  const more = await render(createElement(MorePanel, { theme, compact: true, onClose: () => {}, onAsk: async () => {}, target: { kind: "workspace", workspaceId: "w1" } }));
  assert.equal(more.error, null, `More context crashed on a phone: ${(more.error as Error)?.message}`);
  assert.ok(more.r!.root.findAll(n => n.props.accessibilityLabel === "What do you want to know?").length);
});

// notes-read-like-one-feed (invariant 120): What's new is one scroll like Paseo's own. Every version's number, date and
// changes, the Installed pill on the running one, nothing to open, and the release pages one tap away.
test("What's new on a phone and on desktop: every version in one scroll, nothing to open, the installed one marked", async () => {
  const { WhatsNewSheet } = await import("../client/release-notes");
  const { notesFeed, parseChangelog } = await import("../shared/changelog");
  const many = Array.from({ length: 10 }, (_, i) => `- **Change ${i + 1}:** what it does.`).join("\n");
  const log = parseChangelog(`## 2.4.2 (2026-11-26)\n\nIntro of 2.4.2.\n\n${many}\n\n## 2.4.1 (2026-11-25)\n\n- **Fix:** one.\n\n## 2.0.0 (2026-11-11)\n\nIntro of 2.0.\n\n### One list\n\n- Home is one list.\n`);
  const feed = notesFeed(log, "2.4.1", parseChangelog(`## 2.4.2 (2026-11-26)\n\nIntro of 2.4.2.\n\n${many}\n`));
  const texts = (r: NonNullable<Awaited<ReturnType<typeof render>>["r"]>) => r.root.findAll(n => n.type === "Text").map(n => [n.props.children].flat(Infinity).filter(x => typeof x === "string").join(""));
  for (const compact of [true, false]) {
    let opened: string | null = null;
    const { r, error } = await render(createElement(WhatsNewSheet, { open: true, name: "Follow-up", feed, releases: "https://github.com/example/app/releases", theme, compact, onClose: () => {}, openUrl: (u: string) => { opened = u; } }));
    assert.equal(error, null, `crashed (${compact ? "phone" : "desktop"}): ${(error as Error)?.message}`);
    const all = texts(r!);
    for (const v of ["2.4.2", "2.4.1", "2.0.0"]) assert.ok(all.includes(v), `${v}'s number shows`);
    assert.ok(all.some(t => /November 26, 2026|26 November 2026/.test(t)), "each version's date, in full");
    assert.equal(all.filter(t => t === "Installed").length, 1, "one Installed pill");
    const header = r!.root.findAll(n => n.props.accessibilityRole === "header" && typeof n.props.accessibilityLabel === "string" && n.props.accessibilityLabel.startsWith("2.4.1"));
    assert.match(String(header[0]?.props.accessibilityLabel), /installed/i, "the pill is on the installed version's header, and read aloud");
    assert.ok(all.includes("Intro of 2.4.2.") && all.includes("Intro of 2.0."), "each intro is its version's first paragraph");
    assert.ok(all.includes("One list") && all.includes("Home is one list."), "a curated section reads in full");
    assert.ok(all.includes("Change 10:"), "every bullet, no Show all");
    for (const gone of ["See all release notes", "Show all 10", "versions since you last looked"]) assert.ok(!all.some(t => t.includes(gone)), `no "${gone}"`);
    assert.equal(r!.root.findAll(n => n.props["aria-expanded"] !== undefined || (n.props.accessibilityState as { expanded?: boolean } | undefined)?.expanded !== undefined).length, 0, "no disclosure");
    const link = r!.root.findAll(n => n.props.accessibilityLabel === "Release notes on GitHub" && typeof n.props.onPress === "function")[0];
    assert.ok(link, "the release pages, one tap away");
    await act(async () => { (link!.props.onPress as () => void)(); });
    assert.equal(opened, "https://github.com/example/app/releases");
  }
  const { r } = await render(createElement(WhatsNewSheet, { open: true, name: "Follow-up", feed, releases: null, theme, compact: true, onClose: () => {} }));
  assert.equal(r!.root.findAll(n => n.props.accessibilityLabel === "Release notes on GitHub").length, 0, "no release pages known: no link");
});
