import test from "node:test";
import assert from "node:assert/strict";
import { CATCH_UP_KEYS, CONTEXT_ASKS, MODE, askHeadline, plainAnswer, agentContextPrompt, contextRequestSchema, deckCards, groupOf, nextPos, openInWorkspace, applySwipe, park, prevPos, pruneContext, settle, skipWorkspace, swipeLock, swipeOutcome, startSession, statsOf, sync, type ContextRequest, type DeckCard, type Session } from "../shared/catch-up";
import type { NeedItem } from "../shared/attention";
import type { Workstream } from "../shared/home";

const s = (key: string, patch: Partial<Workstream> = {}) => ({ key, agentId: key.replace(/^\w+:/, ""), workspaceId: `w-${key.replace(/^\w+:/, "")}`, title: key, line: "", ...patch }) as Workstream;
const q = (id: string) => ({ kind: "question", key: `q:${id}`, questionId: id }) as unknown as NeedItem;
const merge = { kind: "merge", key: "merge:example/app#1" } as unknown as NeedItem;
const cards = (...keys: string[]) => keys.map(key => ({ key }));
const none = () => false;

test("the deck deals Home's Needs-you order, one card per ask, a workstream's cards together", () => {
  const model = { groups: [
    { id: "needs", items: [s("agent:a"), s("agent:b"), s("agent:c"), s("agent:d")] },
    { id: "running", items: [s("agent:e")] },
  ] } as never;
  const rows = [
    { agentId: "a", needs: { reasons: [{ reason: "permission" }] }, brief: null },
    { agentId: "b", needs: { reasons: [{ reason: "finished" }] }, brief: { kind: "decision", questionIds: ["Q2"] } },
    { agentId: "c", needs: { reasons: [{ reason: "finished" }] }, brief: { kind: "action" } },
    { agentId: "d", needs: { reasons: [{ reason: "finished" }] }, brief: { kind: "done" } },
  ] as never;
  const items = (id: string): NeedItem[] => id === "w-a" ? [q("Q1")] : id === "w-b" ? [q("Q2"), merge] : [];
  const deck = deckCards({ model, rows, items });
  assert.deepEqual(deck.map(c => c.key), ["agent:a|permission", "agent:a|Q1", "agent:b|Q2", "agent:b|merge:example/app#1", "agent:c|brief", "agent:d|finished"]);
  assert.deepEqual(deck.map(c => c.kind), ["permission", "question", "question", "item", "brief", "finished"]);
  assert.ok(!deck.some(c => c.s.key === "agent:e"), "only Needs you is dealt");
});

test("acting moves on; skipped cards come round again after the rest; done cards stay for Back", () => {
  let x = startSession(cards("a|1", "a|2", "b|1"));
  x = settle(x, "skipped");
  assert.equal(x.order[x.pos], "a|2");
  x = settle(x, "done");
  assert.equal(x.order[x.pos], "b|1");
  x = settle(x, "done");
  assert.equal(x.order[x.pos], "a|1", "the skipped card on a second pass");
  x = settle(x, "done");
  assert.equal(x.pos, x.order.length, "finished");
  assert.equal(x.order[prevPos(x)], "b|1", "Back from finished shows the last card");
  assert.deepEqual(statsOf(x), { done: 3, skipped: 0, later: 0, gone: 0, waiting: 0 });
});

test("skipping everything ends: one second pass for skipped cards, then All caught up with them counted", () => {
  let x = startSession(cards("a|1", "b|1", "c|1"));
  x = settle(x, "skipped"); x = settle(x, "skipped"); x = settle(x, "done");
  assert.equal(x.order[x.pos], "a|1", "the second pass starts at the first skipped card");
  x = settle(x, "skipped");
  assert.equal(x.order[x.pos], "b|1");
  x = settle(x, "skipped");
  assert.equal(x.pos, x.order.length, "skipped twice: finished, never round again");
  assert.deepEqual(statsOf(x), { done: 1, skipped: 2, later: 0, gone: 0, waiting: 0 });
});

test("Skip workspace skips every open card of the workspace, counts each, and they come back on the second pass", () => {
  let x = startSession(cards("a|1", "b|1", "b|2", "b|3", "c|1"));
  x = settle(x, "done");
  assert.equal(x.order[x.pos], "b|1");
  assert.deepEqual(openInWorkspace(x), ["b|1", "b|2", "b|3"], "three left: Skip workspace shows");
  x = skipWorkspace(x);
  assert.equal(x.order[x.pos], "c|1", "the next workspace");
  assert.equal(statsOf(x).skipped, 3, "N skipped counts cards");
  assert.equal(x.order[prevPos(x)], "b|1", "Back returns to the card Skip workspace was pressed on");
  x = settle(x, "done");
  assert.equal(x.order[x.pos], "b|1", "the second pass picks them up");
  x = settle(x, "done");
  assert.equal(x.order[x.pos], "b|2");
  assert.equal(x.order[prevPos(x)], "b|1", "away from where it landed, Back is the card before again");
});

test("Skip workspace on the second pass moves past the rest of that workspace; with one card left it is plain Skip", () => {
  let x = startSession(cards("a|1", "a|2", "b|1", "c|1"));
  x = skipWorkspace(x);
  assert.equal(x.order[x.pos], "b|1");
  x = settle(x, "done"); x = settle(x, "done");
  assert.equal(x.order[x.pos], "a|1"); assert.ok(x.lapped);
  x = skipWorkspace(x);
  assert.equal(x.pos, x.order.length, "the end, not a|2");
  assert.equal(statsOf(x).skipped, 2);
  assert.equal(x.order[prevPos(x)], "a|1", "Back from the end returns to where it was pressed");
  const one = startSession(cards("a|1", "b|1"));
  assert.deepEqual(openInWorkspace(one), ["a|1"], "one card left: no Skip workspace");
  assert.deepEqual(skipWorkspace(one).pos, settle(one, "skipped").pos);
});

test("a live change keeps the second pass and Back after Skip workspace", () => {
  let x = startSession(cards("a|1", "a|2", "b|1"));
  x = skipWorkspace(x);
  x = sync(x, cards("a|1", "a|2", "b|1", "d|1"), none);
  assert.equal(x.order[prevPos(x)], "a|1");
  x = { ...x, lapped: true };
  assert.equal(sync(x, cards("a|1", "a|2", "b|1", "d|1"), none).lapped, true, "sync never drops lapped");
});

test("a left swipe skips the whole workspace; a right swipe goes Back to the card it was on", () => {
  let x = startSession(cards("a|1", "b|1", "b|2", "b|3", "c|1"));
  x = settle(x, "done");
  const left = swipeOutcome({ dx: -200, vx: 0, width: 390, canBack: true });
  x = applySwipe(x, left);
  assert.deepEqual(["b|1", "b|2", "b|3"].map(k => x.outcomes[k]), ["skipped", "skipped", "skipped"], "every open card of the workspace");
  assert.equal(x.order[x.pos], "c|1", "the next workspace");
  x = applySwipe(x, swipeOutcome({ dx: 200, vx: 0, width: 390, canBack: true }));
  assert.equal(x.order[x.pos], "b|1", "Back returns to the card the swipe left");
  const one = startSession(cards("a|1", "b|1"));
  assert.deepEqual(applySwipe(one, left).outcomes, settle(one, "skipped").outcomes, "one card left: the same as skipping it");
  assert.equal(applySwipe(one, "stay"), one, "a spring back changes nothing");
});

test("the phone drag locks its direction early and commits on distance or a fling", () => {
  assert.equal(swipeLock(3, 2), null, "too soon to tell");
  assert.equal(swipeLock(-12, 4), "x");
  assert.equal(swipeLock(6, 12), "y", "a scroll stays a scroll");
  assert.equal(swipeLock(9, 8), "y", "diagonal is a scroll");
  const w = 390;
  assert.equal(swipeOutcome({ dx: -195, vx: 0, width: w, canBack: true }), "skip-workspace", "held halfway and let go");
  assert.equal(swipeOutcome({ dx: -60, vx: 0, width: w, canBack: true }), "stay", "springs back");
  assert.equal(swipeOutcome({ dx: -60, vx: -0.9, width: w, canBack: true }), "skip-workspace", "a fling");
  assert.equal(swipeOutcome({ dx: -200, vx: 0.9, width: w, canBack: true }), "skip-workspace", "far enough, whatever the last flick");
  assert.equal(swipeOutcome({ dx: 40, vx: -0.9, width: w, canBack: true }), "stay", "a fling against the drag");
  assert.equal(swipeOutcome({ dx: 200, vx: 0, width: w, canBack: true }), "back");
  assert.equal(swipeOutcome({ dx: 200, vx: 0, width: w, canBack: false }), "stay", "nothing to go back to");
});

test("a card handled elsewhere is gone, never pulled from under the developer; a new card joins at the end", () => {
  let x = startSession(cards("a|1", "b|1", "c|1"));
  x = sync(x, cards("b|1", "c|1", "d|1"), none);
  assert.equal(x.order[x.pos], "a|1", "the card on screen stays, marked gone");
  assert.equal(x.outcomes["a|1"], "gone");
  assert.deepEqual(x.order, ["a|1", "b|1", "c|1", "d|1"]);
  x = settle(x, "done", "b|1");
  assert.equal(x.order[x.pos], "a|1", "settling another card doesn't move the screen");
  assert.equal(nextPos(x, x.pos), 2);
});

test("context-never-blocks-the-deck: More context parks the workstream and the deck moves on", () => {
  let x = startSession(cards("a|1", "a|2", "b|1", "c|1"));
  x = park(x, "ctx-1");
  assert.equal(x.order[x.pos], "b|1", "skips the rest of a's cards");
  assert.equal(statsOf(x).waiting, 2);
  x = settle(x, "done");
  assert.equal(x.order[x.pos], "c|1");
  // The answer arrives while c|1 is on screen: a comes back right after it, never in its place.
  x = sync(x, cards("a|1", "a|2", "b|1", "c|1"), id => id === "ctx-1");
  assert.equal(x.order[x.pos], "c|1");
  assert.deepEqual(x.order.slice(x.pos), ["c|1", "a|1", "a|2"]);
  assert.equal(statsOf(x).waiting, 0);
  x = settle(x, "done");
  assert.equal(x.order[x.pos], "a|1", "the asked card is the very next one");
});

test("context: Back reaches a parked card, and a finished deck still counts what waits", () => {
  let x = startSession(cards("a|1", "b|1"));
  x = park(x, "ctx-1");
  assert.equal(x.order[x.pos], "b|1");
  assert.equal(x.order[prevPos(x)], "a|1", "the parked card isn't lost going Back");
  x = settle(x, "done");
  assert.equal(x.pos, x.order.length, "nothing else to land on");
  assert.equal(statsOf(x).waiting, 1, "the finished screen counts the card still getting context");
  x = sync(x, cards("a|1", "b|1"), () => true);
  assert.equal(x.order[x.pos], "a|1", "an answer on a finished deck becomes the current card");
});

test("context: a parked card handled elsewhere doesn't come back", () => {
  let x: Session = startSession(cards("a|1", "b|1", "c|1"));
  x = park(x, "ctx-1");
  x = sync(x, cards("b|1", "c|1"), () => false);
  assert.equal(x.outcomes["a|1"], "gone");
  x = sync(x, cards("b|1", "c|1"), () => true);
  assert.equal(x.order[x.pos], "b|1");
  assert.deepEqual(x.order.slice(x.pos), ["b|1", "c|1"], "nothing open to return");
  assert.deepEqual(x.parked, {});
});

test("groupOf keeps a workstream's cards together", () => {
  assert.equal(groupOf("agent:a|Q1"), "agent:a");
  assert.equal(groupOf("ws:w1|merge:example/app#1"), "ws:w1");
});

test("the mode's words: Catch up, counts cards, All caught up", () => {
  assert.equal(MODE.button(17), "Catch up · 17");
  assert.match(MODE.buttonLabel(17), /17 things/);
  assert.equal(MODE.command, "Follow-up: Catch up on what needs you");
  assert.equal(MODE.progress(3, 17), "Catch up 3 of 17");
  assert.equal(MODE.finished, "All caught up");
  assert.equal(MODE.endOfDeck, "End of the deck", "a deck ended with cards skipped or waiting does not claim All caught up");
  assert.equal(CONTEXT_ASKS[0].label, "I don't get it", "Tom: the question usually just needs explaining");
  assert.ok(CATCH_UP_KEYS.some(k => k.key === "S" && k.action === "keys"), "the keys sheet is S: Paseo binds ?");
});

const request = (patch: Partial<ContextRequest> = {}): ContextRequest => contextRequestSchema.parse({
  id: "ctx-1", workspaceId: "w1", agentId: "a1", cardKey: "agent:a1|Q1", card: "Q1: Which retry policy?", target: "agent", ask: "I don't get it",
  askedOf: "a1", state: "asking", answer: null, error: null, askedAt: "2026-11-17T10:00:00.000Z", settledAt: null, by: "developer", ...patch,
});

test("context prompts carry the request id and never read as the developer's answer", () => {
  const r = request();
  for (const text of [agentContextPrompt(r)]) {
    assert.match(text, /ctx-1/);
    assert.match(text, /context_reply/);
    assert.ok(!/\bTom\b/.test(text));
  }
  assert.match(agentContextPrompt(r), /isn't their answer/);
});

test("context requests are pruned by age (30 days) and count (200 a workspace)", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");
  const old = request({ id: "old", askedAt: "2026-10-18T10:00:00.000Z" });
  const young = Array.from({ length: 210 }, (_, i) => request({ id: `y${i}`, askedAt: new Date(now - (210 - i) * 1000).toISOString() }));
  const kept = pruneContext([old, ...young], now);
  assert.equal(kept.length, 200);
  assert.equal(kept[0].id, "y10");
  assert.ok(!kept.some(r => r.id === "old"));
});

// Type-level: a DeckCard keeps its workstream for the card's header.
const _card: Pick<DeckCard, "s"> = { s: s("agent:a") };
void _card;

test("a context answer shows as plain words, and the card quotes the ask's first sentence", () => {
  assert.equal(plainAnswer("## Short version\n**Update** keeps one contact; __skip__ drops the row. See https://example.com/a**b"), "Short version\nUpdate keeps one contact; skip drops the row. See https://example.com/a**b");
  assert.equal(askHeadline(CONTEXT_ASKS[0].text), "I don't get it.");
  assert.equal(askHeadline("why"), "why");
});
