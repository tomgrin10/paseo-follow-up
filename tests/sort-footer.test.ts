import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rankFooter } from "../shared/ranker";

// The sort menu's footer says only when the ranking last ran (and why a run failed), never what it cost.
const NOW = Date.parse("2026-11-10T07:30:00.000Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const on = { enabled: true, running: false, error: null };

test("the footer is when the ranking last ran, nothing else", () => {
  assert.equal(rankFooter({ rankedAt: ago(60), now: NOW, rank: on }), "Ranked 1h ago");
  assert.equal(rankFooter({ rankedAt: ago(12), now: NOW, rank: on }), "Ranked 12m ago");
  // Never ran: says so. With the ranker off and nothing ranked, the Priority row's own hint says it all.
  assert.equal(rankFooter({ rankedAt: null, now: NOW, rank: on }), "Not ranked yet");
  assert.equal(rankFooter({ rankedAt: null, now: NOW, rank: { ...on, enabled: false } }), null);
  assert.equal(rankFooter({ rankedAt: ago(90), now: NOW, rank: { ...on, enabled: false } }), "Ranked 1h ago");
  // Running: the menu item says "Ranking…"; the footer keeps the standing ranking's age.
  assert.equal(rankFooter({ rankedAt: ago(60), now: NOW, rank: { ...on, running: true } }), "Ranked 1h ago");
  assert.equal(rankFooter({ rankedAt: null, now: NOW, rank: { ...on, running: true } }), "Ranking now");
  // Failed: the short reason, which the developer can act on.
  assert.equal(rankFooter({ rankedAt: ago(180), now: NOW, rank: { ...on, error: "No outside source could be read." } }), "Ranked 3h ago · Last run failed: No outside source could be read");
  assert.equal(rankFooter({ rankedAt: null, now: NOW, rank: { ...on, error: "Claude CLI not logged in" } }), "Last run failed: Claude CLI not logged in");
  const long = rankFooter({ rankedAt: null, now: NOW, rank: { ...on, error: "x".repeat(200) } })!;
  assert.ok(long.length <= 80 && long.endsWith("…"), long);
});

test("no cost and no 'Home uses this order too' ever reaches the sort menu's footer", async () => {
  const states = [on, { ...on, running: true }, { ...on, error: "Run failed" }, { ...on, enabled: false }];
  for (const rank of states) for (const rankedAt of [null, ago(5), ago(600)]) {
    const s = rankFooter({ rankedAt, now: NOW, rank: { ...rank, costUsd: 0.0564, last: { ok: true, skipped: null, provider: "claude" } } as never }) ?? "";
    assert.doesNotMatch(s, /\$|cost|subscription|Home uses/i, s);
  }
  const src = await readFile(new URL("../client/home-chrome.tsx", import.meta.url), "utf8");
  const menu = src.slice(src.indexOf("export function DisplayMenu"), src.indexOf("export function FilterLine"));
  assert.match(menu, /rankFooter\(/, "the footer's text comes from rankFooter");
  assert.doesNotMatch(menu, /rankCost|costUsd|uses this order too|Priority: /);
});
