import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sameText } from "../shared/home";

// The phone rework (2026-11-09). The client needs the Paseo host to render, so the structural checks read the JSX.
const source = (path: string) => readFile(resolve(path), "utf8");

test("sameText: the headline and a question's detail count as one sentence", () => {
  const line = "Needs Cyera input and a product decision; out of scope for #1366/#1369";
  assert.ok(sameText(line, `${line}.`));
  assert.ok(sameText(`  ${line.toUpperCase()} `, line));
  assert.ok(sameText("Waiting on   review", "waiting on review!"));
  assert.ok(!sameText(line, "Get Cyera answers for the 10 Ask-Cyera pairs"));
  assert.ok(!sameText("", ""), "two empty lines aren't a duplicate to hide");
  assert.ok(!sameText(null, undefined));
});

test("Home's detail pane drops its headline when a Needs-you row already says it", async () => {
  const home = await source("client/home.tsx");
  assert.match(home, /const echoed = !!s\.line && asks\.some\(i => sameText\(i\.title, s\.line\) \|\| \("detail" in i && sameText\(i\.detail, s\.line\)\)\)/);
  const pane = home.slice(home.indexOf("function DetailPane"), home.indexOf("function OverseerPane"));
  assert.match(pane, /: echoed \|\|/, "the headline branch is skipped when echoed");
});

test("phones: a Home row opens its own screen, so the host's back is the only back control", async () => {
  const home = await source("client/home.tsx");
  const index = await source("index.client.tsx");
  assert.match(index, /openItem = \(key: string\) => client\.openScreen\(\{ screenId: OVERVIEW, params: \{ item: key \} \}\)/);
  assert.match(home, /const route = compact && deps\.openItem \? deps\.openItem : null;/);
  // Our chevron only exists where Home swaps panes in place (no route), never beside the host's ←.
  for (const m of home.matchAll(/onBack=\{([^}]*)\}/g)) assert.match(m[1], /compact && !route \?/, m[0]);
  // The phone pane head has no back control and Open full is an icon.
  const pane = home.slice(home.indexOf("function DetailPane"), home.indexOf("function OverseerPane"));
  const phoneHead = pane.slice(pane.indexOf("const header = compact ?"), pane.indexOf(": <View style={{ paddingHorizontal: 20"));
  assert.doesNotMatch(phoneHead, /ChevronLeft/);
  assert.match(phoneHead, /<IconButton theme=\{theme\} compact icon="PanelRightOpen" label="Open full"/);
  assert.match(phoneHead, /numberOfLines=\{1\}/, "the meta line ellipsizes instead of wrapping");
});

test("phones: the composer dock clears the bottom inset and keeps its hint off the screen edge", async () => {
  const home = await source("client/home.tsx");
  assert.match(home, /backgroundColor: c\.surface0 \}, bottomInset\(compact\)\]\}>\s*\{moves\}\s*<ReplyBox/);
  assert.match(home, /\{!!hint && !compact && <Text/, "the visible hint is desktop-only");
  assert.match(home, /accessibilityHint=\{compact && hint \? hint : undefined\}/, "phones keep it as the input's hint");
  const kit = await source("client/kit.tsx");
  assert.match(kit, /env\(safe-area-inset-bottom\)/);
});

test("the pill's title names the kind of ask, so the phone sheet doesn't repeat the ask under it", async () => {
  const pill = await source("client/pill.tsx");
  assert.match(pill, /`Follow-up · \$\{state\.headline\.label\}/);
  assert.doesNotMatch(pill, /`Follow-up: \$\{state\.headline\.line\}/);
});

test("a Needs-you row doesn't repeat its question as its detail", async () => {
  const needs = await source("client/needs-you.tsx");
  const guarded = [...needs.matchAll(/!!item\.detail && !sameText\(item\.detail, item\.title\.replace\(\/\^Q\\d\+ · \/, ""\)\)/g)].length;
  assert.equal(guarded, 2, "both row layouts skip a detail that only repeats the title");
  assert.ok(sameText("Q1 · Which fix should ship?".replace(/^Q\d+ · /, ""), "Which fix should ship?"));
});
