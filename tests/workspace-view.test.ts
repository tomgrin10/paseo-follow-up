import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HYSTERESIS, layoutFor, placeCards } from "../shared/workspace-layout";
import { rowOpens } from "../shared/display";

/**
 * The workspace view (invariant 135, one-workspace-view): one view in Home's pane, the side panel and the main tab,
 * its layout from its own width only. A row in Follow-up's sidebar list opens it or the chat per `open_workspace_on`.
 */
const src = (f: string) => readFile(join(import.meta.dirname, "..", f), "utf8");

test("the tier comes from width alone: dense, roomy, two columns, three columns", () => {
  assert.deepEqual(layoutFor(0), { tier: "dense", columns: 1, dense: true, steps: 5 }, "unmeasured reads as the narrowest place");
  assert.deepEqual(layoutFor(559), { tier: "dense", columns: 1, dense: true, steps: 5 });
  assert.deepEqual(layoutFor(560), { tier: "roomy", columns: 1, dense: false, steps: 6 });
  assert.deepEqual(layoutFor(760), { tier: "two", columns: 2, dense: false, steps: 8 });
  assert.deepEqual(layoutFor(1399), { tier: "two", columns: 2, dense: false, steps: 8 });
  assert.deepEqual(layoutFor(1400), { tier: "three", columns: 3, dense: false, steps: 10 });
});

test("free cards go to the shorter column; pinned ones stay; in three columns the agent's column takes none", () => {
  const cards = [{ key: "agent", column: 0 }, { key: "needs", column: 1 }, { key: "log" }, { key: "spec" }];
  assert.deepEqual(placeCards(cards, 1, {}), { agent: 0, needs: 0, log: 0, spec: 0 });
  const two = placeCards(cards, 2, { agent: 300, needs: 100, log: 300, spec: 200 });
  assert.equal(two.log, 1, "beside the shorter Needs you (100 < 300)");
  assert.equal(two.spec, 0, "then the agent's column is the shorter (300 < 400)");
  const three = placeCards(cards, 3, { agent: 100, needs: 300, log: 200, spec: 50 });
  assert.equal(three.log, 2);
  assert.equal(three.spec, 2, "column 2 (200) is shorter than 1 (300); never column 0");
});

test("a card stays in its column unless the move gains more than the hysteresis", () => {
  const cards = [{ key: "a", column: 0 }, { key: "b", column: 1 }, { key: "log" }];
  const near = placeCards(cards, 2, { a: 100, b: 100 + HYSTERESIS, log: 50 }, { log: 1 });
  assert.equal(near.log, 1, "within the hysteresis it keeps its column");
  const far = placeCards(cards, 2, { a: 100, b: 100 + HYSTERESIS + 1, log: 50 }, { log: 1 });
  assert.equal(far.log, 0);
});

test("a row opens its workspace view by default, the chat on chat, and Cmd/Ctrl flips it", () => {
  const row = { agentId: "a1", workspaceId: "w1" };
  assert.equal(rowOpens(row, undefined, false), "view");
  assert.equal(rowOpens(row, "chat", false), "chat");
  assert.equal(rowOpens(row, "view", true), "chat");
  assert.equal(rowOpens(row, "chat", true), "view");
  assert.equal(rowOpens({ agentId: null, workspaceId: "w1" }, "chat", false), "view", "no agent: the view is all there is");
  assert.equal(rowOpens({ agentId: "a1", workspaceId: null }, "view", false), "chat", "no workspace: its chat");
  assert.equal(rowOpens({ agentId: null, workspaceId: null }, "view", false), null);
});

test("the side panel never draws the reply box, and its Recent steps start folded", async () => {
  const card = await src("client/agent-card.tsx");
  assert.match(card, /useFold\(PANEL_FOLDS\.steps, place !== "panel"\)/);
  assert.match(card, /useMarkTimelineOnScreen\(place !== "panel" && open \? agentId : null\)/, "the panel reads, never marks");
  const panel = await src("client/panel.tsx");
  assert.match(panel, /reply=\{place !== "panel" && !dock\}/);
  const home = await src("client/home.tsx");
  assert.equal((home.match(/= useTail\(/g) ?? []).length, 1, "only the Overseer's pane still reads its tail; an item's pane never loads (wakes) its agent");
});

test("while anything waits on the developer, Needs you takes the left (wide) column and the agent card moves over", async () => {
  const panel = await src("client/panel.tsx");
  assert.match(panel, /const agentCol = waiting \? 1 : 0;/);
  // A card a question points at stays right under Needs you, in its column (client/shown-cards.tsx).
  assert.match(panel, /\.\.\.\(waiting \? \[\{ key: "needs", node: needs, column: 0 \}, \{ key: "pointed", node: pointedCards, column: 0 \}\] : \[\]\)/);
  assert.match(panel, /col === 0 \? AGENT_SHARE/, "the left column is the wide one");
});

test("the retired larger view only redirects to the tab", async () => {
  const large = await src("client/large.tsx");
  assert.match(large, /openView\(workspaceId\)/);
  assert.doesNotMatch(await src("index.client.tsx"), /open-follow-up-large/);
});
