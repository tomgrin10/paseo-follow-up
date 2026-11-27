import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { railChips, type Workstream } from "../shared/home";

/**
 * row-chips-never-cover-the-time (2026-11-16): a desktop Home row's badges and PR chip yield (shrink, drop the
 * lowest-ranked chip, truncate the last one) before the time column moves. The geometry is checked in a real browser
 * by `scripts/screenshots.mjs --only rowchips` (CDP boxes at list widths 320, 360 and 400); this pins the layout rules.
 */
const src = () => readFile(join(import.meta.dirname, "..", "client/home-list.tsx"), "utf8");
const block = (s: string, start: string) => { const i = s.indexOf(start); assert.ok(i >= 0, `${start} not found`); return s.slice(i, s.indexOf("\n}", i)); };

test("the desktop row draws its chips through one rail, never loose beside the line", async () => {
  const s = await src();
  const row = block(s, "const Row = memo(");
  const desktop = row.slice(row.indexOf("</View> : <View style={{ flex: 1"));
  assert.match(desktop, /<ChipRail s=\{rail\} c=\{c\} dim=\{older\} \/>/);
  assert.doesNotMatch(desktop, /<BadgeView|<PrChipView/, "a chip outside the rail can't yield");
});

test("the rail shrinks first, clips its second line, and keeps chips in priority order", async () => {
  const rail = block(await src(), "function ChipRail(");
  for (const rule of [/flexShrink: 1000/, /minWidth: 0/, /height: 20/, /overflow: "hidden"/, /flexWrap: "wrap"/]) assert.match(rail, rule);
  assert.match(rail, /railChips\(s\)/, "the rail draws railChips' order: the last to fit drops first");
});

test("chips rank red, amber, green, grey: a failing check outlasts Approved", () => {
  const pr = (tone: "danger" | "success" | "muted" | null) => ({ label: "#142", tone: "open", checks: tone ? { text: "x", tone } : null, url: null }) as unknown as Workstream["pr"];
  const order = (badges: Workstream["badges"], p: Workstream["pr"]) => railChips({ badges, pr: p }).map(c => c.kind === "badge" ? c.badge.text : "PR");
  assert.deepEqual(order([{ text: "Asks you", tone: "warning" }, { text: "Approved", tone: "success" }], pr("danger")), ["PR", "Asks you", "Approved"]);
  assert.deepEqual(order([{ text: "Asks you", tone: "warning" }, { text: "Approved", tone: "success" }], pr("success")), ["Asks you", "Approved", "PR"]);
  assert.deepEqual(order([{ text: "Merge ready", tone: "success" }, { text: "Conflict", tone: "danger" }], pr(null)), ["Conflict", "Merge ready", "PR"]);
  assert.deepEqual(order([{ text: "Main agent changed", tone: "muted" }], pr("muted")), ["PR", "Main agent changed"]);
  assert.deepEqual(order([], null), []);
});

test("a Needs-you row's word keeps its place, and the row's label names every chip, even a hidden one", async () => {
  const row = block(await src(), "const Row = memo(");
  assert.match(row, /s\.word && s\.group === "needs" \? <Text numberOfLines=\{1\} style=\{\{ flexShrink: 0, color, fontSize: 12 \}\}>\{s\.word\}/);
  assert.match(row, /\.\.\.s\.badges\.map\(b => b\.text\), s\.pr && prChipSpoken\(s\.pr\)/);
});

test("a lone chip truncates instead of overflowing; the time never shrinks", async () => {
  const s = await src();
  for (const name of ["export function BadgeView(", "export function PrChipView("]) assert.match(block(s, name), /flexShrink: 1, minWidth: 0/, name);
  assert.match(block(s, "export function PrChipView("), /flexShrink: 0, color: c\.foreground[^]*\{s\.pr\.label\}/, "the PR number never truncates; its checks text does");
  assert.match(block(s, "function RowTime("), /testID="follow-up-row-time" style=\{\{ flexShrink: 0 \}\}/);
});
