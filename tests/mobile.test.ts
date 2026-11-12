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
  assert.match(index, /openItem = \(key: string(, extra: \{ question\?: string \} = \{\})?\) => client\.openScreen\(\{ screenId: OVERVIEW, params: \{ item: key[ ,}]/);
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

test("phones: the state word lifts dark success green to text contrast; light and passing hues are untouched", async () => {
  const { readable } = await import("../client/theme");
  const dark = { surface0: "#181b1a" } as never; const light = { surface0: "#ffffff" } as never;
  const lum = (rgb: number[]) => { const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const lifted = readable("#20744a", dark);
  const rgb = /rgb\((\d+), (\d+), (\d+)\)/.exec(lifted)!.slice(1).map(Number);
  assert.ok((lum(rgb) + 0.05) / (lum([24, 27, 26]) + 0.05) >= 4.5, lifted);
  assert.equal(readable("#20744a", light), "#20744a");
  assert.equal(readable("#e0e0e0", dark), "#e0e0e0");
});

test("phones: the Summary row's footer is one meta line, and the Summary has no open state to share", async () => {
  const { shortFooter } = await import("../shared/about");
  assert.equal(shortFooter("Summarized by Haiku · 2m ago from the chat, 2 PRs"), "Haiku · 2m ago");
  assert.equal(shortFooter("Summarized 3h ago from the goal"), "3h ago");
  const about = await source("client/about.tsx");
  assert.doesNotMatch(about, /readOpen|writeOpen/);
  assert.match(about, /d\.footer \? shortFooter\(d\.footer\)/, "the short form on every size: a narrow panel clipped the time");
});

test("phones: the pill sheet has one primary; Sign off steps back while the workspace has something to act on", async () => {
  const pill = await source("client/pill.tsx");
  assert.match(pill, /const itemFirst = touch && !!w && \(asking \|\| items\.length > 0\)/);
  assert.match(pill, /kind=\{itemFirst \? "secondary" : "primary"\} icon="Check" title="Sign off"/);
  // An open question is the stepper's (its Send is the primary); the list only draws the other rows. The featured
  // question row is gone: the Needs you block's question card is the one place a question renders (an-open-question-renders-once-per-surface).
  assert.match(pill, /asking\s*\? <QuestionStepper[^]*?: <NeedsYouList /);
});

test("phones: only Home's search row stays pinned; the status chips and the setup offer scroll with the list", async () => {
  const home = await source("client/home.tsx");
  assert.match(home, /\{!compact && !omnibox\.results && <StatusStrip/);
  assert.match(home, /\{!compact && !omnibox\.results && <SetupOffer/);
  assert.match(home, /header=\{omnibox\.results \? undefined : compact \? <View[^>]*>[^]*?<StatusStrip[^]*?<SetupOffer theme=\{theme\} compact/, "the chips (and the version marker beside them) scroll in the list header");
});

test("phones: every state word's hue is lifted to text contrast, not only success (Finished is the accent)", async () => {
  const list = await source("client/home-list.tsx");
  assert.match(list, /return text \? readable\(base, c\) : base;/);
});

test("phones: Home's search results use the list row, the offer sits after Needs you, and the empty state has an action", async () => {
  const list = await source("client/home-list.tsx");
  assert.match(list, /case "result": return <Row /, "a result is the list's own Row (search-row-is-the-list-row), two-line 15px title and all");
  assert.ok(!/GroupChip/.test(await source("client/home-chrome.tsx")), "no group pill: the state word already says it");
  const home = await source("client/home.tsx");
  assert.match(home, /afterNeeds=\{compact && model\.needs > 0 \? <SetupOffer/);
  assert.match(home, /emptyAction=\{compact \? <Button [^>]*title="Project settings"/);
  assert.match(home, /\{!\(compact && nothing\) && <SortMenu/);
});
