import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// The Summary is one quiet line directly under the workspace's title, with no heading, fold or Linked list
// (Tom, 2026-11-10). The client needs the Paseo host to render, so these read the JSX of the surfaces directly.

const source = (path: string) => readFile(resolve(path), "utf8");

test("Home's detail pane: the Summary sits right under the title on phone and desktop, and the old section is gone", async () => {
  const home = await source("client/home.tsx");
  const pane = home.slice(home.indexOf("const header = "), home.indexOf("function OverseerPane") > 0 ? home.indexOf("function OverseerPane") : undefined);
  assert.doesNotMatch(pane, /<AboutSection\b/);
  const [phone, desktop] = pane.split(" : <View");
  for (const [name, part] of [["phone", phone], ["desktop", desktop]] as const) {
    const title = part.indexOf('accessibilityRole="header"');
    const line = part.indexOf("<SummaryLine");
    assert.ok(title > 0 && line > title, `${name}: after the title`);
    assert.ok(line < part.indexOf("<PrSummaryText") || part.indexOf("<PrSummaryText") < 0 || name === "desktop", `${name}: before the meta line`);
  }
});

test("the workspace panel: the Summary takes the goal's slot under the title; Rewrite lives in Spec, agent and recovery", async () => {
  const header = await source("client/header.tsx");
  assert.equal([...header.matchAll(/<SummaryLine\b/g)].length, 3, "phone, narrow/large lead and desktop");
  assert.doesNotMatch(header, /<Text[^>]*>\{w\.goal\}<\/Text>/, "the goal only shows through the Summary line's fallback");
  const panel = await source("client/panel.tsx");
  assert.doesNotMatch(panel, /AboutSection|\babout=\{/);
  const card = panel.slice(panel.indexOf('label="Spec, agent and recovery"'));
  assert.ok(card.indexOf("<SummaryRow") > 0 && card.indexOf("<SummaryRow") < card.indexOf("Main agent"), "first row after the spec");
});

test("no Linked list, label or fold is left in the Summary's UI", async () => {
  const about = await source("client/about.tsx");
  assert.doesNotMatch(about, /Linked|LinkRow|ChevronDown|aria-expanded|"What/);
  assert.match(about, /numberOfLines=\{3\}/);
});
