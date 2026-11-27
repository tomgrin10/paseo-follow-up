// What an agent shows (client/shown-cards.tsx, client/card-blocks.tsx) lays out by the card's own width through
// shared/card-view.ts. These pin the math the harness guard (`scripts/screenshots.mjs --only cards`) checks on screen:
// nothing wider than its card, wide tables scroll with the first column pinned, pairs go two-up under 520 px, images are
// never cropped or blown up, a folded card has a height budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARD_VIEW, cardMode, cellWidth, fitInto, foldedBudget, freshLabel, isNumeric, legendItems, linePoints, pointedCards, singleBox, stableOrder, tableLayout, textClips, thumbBox, barFractions, codeLines, diffTone, fileKind, shownAddress, bytesLabel } from "../shared/card-view";
import { parseMd, inline } from "../shared/card-md";
import { CARD_LIMITS, freshness, type Cell } from "../shared/cards";

/** Every width the workspace view runs at: phones 360/390 (cards 328/358), the side panel 400 (376), a column of the tab, Home's pane. */
const WIDTHS = [328, 358, 376, 420, 480, 560, 760, 1000, 1876];

test("card-view: pairs go side by side from 520 px, freshness moves to the subtitle under 440", () => {
  assert.equal(cardMode(519, false).sideBySide, false);
  assert.equal(cardMode(520, false).sideBySide, true);
  assert.equal(cardMode(439, true).freshInSubtitle, true);
  assert.equal(cardMode(440, true).freshInSubtitle, false);
  for (const w of WIDTHS) {
    const m = cardMode(w, w < 400);
    assert.ok(m.galleryCols >= 2 && m.galleryCols <= 4, `${w}: ${m.galleryCols} thumbnails a row`);
    if (w < CARD_VIEW.narrowHead) assert.equal(m.galleryCols, 2);
    // A row of thumbnails never runs past the card's inside.
    assert.ok(cellWidth(m.inner, m.galleryCols) * m.galleryCols + 8 * (m.galleryCols - 1) <= m.inner, `${w}: the gallery fits`);
    assert.ok(cellWidth(m.inner, 2, 6) * 2 + 6 <= m.inner, `${w}: a before/after pair fits`);
  }
});

test("card-view: images fit their box, never cropped or blown up", () => {
  const box = { width: 300, height: 188 };
  const tall = fitInto({ width: 400, height: 4000 }, box);
  assert.ok(tall.height <= box.height && tall.width <= box.width && Math.abs(tall.width / tall.height - 0.1) < 0.01, "a tall image is pillar-boxed at its shape");
  const wide = fitInto({ width: 6000, height: 200 }, box);
  assert.ok(wide.width <= box.width && wide.height >= 1, "a wide image is letter-boxed");
  assert.deepEqual(fitInto({ width: 16, height: 16 }, box), { width: 32, height: 32 }, "a tiny image is at most twice its size");
  assert.deepEqual(fitInto({ width: 0, height: 0 }, box), box, "unknown size fills the box");
  assert.ok(singleBox({ width: 800, height: 6000 }, 500).height <= CARD_VIEW.singleMaxHeight, "a single tall image is capped");
  assert.equal(thumbBox(160).height, 100);
});

test("card-view: tables fit or scroll with the first column pinned, numbers right-aligned", () => {
  const cols = ["Endpoint", "Before p95", "After p95", "Change"];
  const rows: Cell[][] = [["POST /checkout", "640 ms", "301 ms", { value: "−53%", tone: "good" }], ["GET /cart", "210 ms", "118 ms", { value: "−44%", tone: "good" }]];
  const fits = tableLayout(cols, rows, 460);
  assert.equal(fits.scroll, false);
  assert.ok(fits.total <= 460, "fitted columns never pass the card");
  assert.deepEqual(fits.numeric, [false, true, true, true]);
  // The side panel's card (294 inside): a 4-column benchmark fits, its headers wrapping, so "Change" is never cut off.
  assert.equal(tableLayout(cols, [...rows, ["POST /coupon", "95 ms", "102 ms", { value: "+7%", tone: "bad" }]], 294).scroll, false);
  // At the limit: 8 columns of 50 rows, with long unbroken words.
  const wideCols = Array.from({ length: CARD_LIMITS.columns }, (_, j) => j ? `Option ${j} with a long header` : "");
  const wideRows: Cell[][] = Array.from({ length: CARD_LIMITS.rows }, (_, i) => wideCols.map((_, j) => j ? `${"x".repeat(60)}${i}` : `Row ${i} ${"y".repeat(80)}`));
  for (const w of WIDTHS) {
    const lay = tableLayout(wideCols, wideRows, w);
    // Narrow cards scroll; a wide tab fits all eight (each column at most colMax).
    if (w < 1700) assert.equal(lay.scroll, true, `${w}: 8 wide columns scroll`);
    else assert.ok(!lay.scroll && lay.total <= w, `${w}: 8 columns fit a wide tab`);
    assert.ok(lay.scroll ? lay.widths[0] <= CARD_VIEW.firstColMax && lay.widths.every(x => x >= CARD_VIEW.colMin && x <= CARD_VIEW.colMax) : lay.widths.every(x => x >= CARD_VIEW.colMin), `${w}: column widths are bounded (${lay.widths})`);
    // The pinned first column leaves room for the scroller beside it.
    assert.ok(lay.widths[0] <= w * 0.6, `${w}: the pinned column leaves room`);
  }
  // An option comparison (a recommended column) aligns left even where cells are numbers.
  const option = tableLayout(["", "A", "B"], [["Cost", "$0", "$18"]], 400, { recommend: 1 });
  assert.deepEqual(option.numeric, [false, false, false]);
  // A state matrix: glyph columns and a legend.
  const matrix = tableLayout(["", "Chrome", "Firefox"], [["macOS", { state: "done" }, { state: "running" }], ["Ubuntu", { state: "failed" }, { state: "todo" }]], 400);
  assert.deepEqual(matrix.states, [false, true, true]);
  assert.deepEqual(legendItems(matrix.legend, true).map(l => l.word), ["passed", "failed", "was running", "not started"]);
  assert.ok(isNumeric("1,204,000") && isNumeric("$40") && isNumeric(12.5) && !isNumeric("we write them") && !isNumeric("macOS 15"));
});

test("card-view: long text clips past six lines, short text never does", () => {
  assert.equal(textClips("All six slides redone in the dark look.", 400, false), false);
  assert.equal(textClips("word ".repeat(900), 400, false), true);
  assert.equal(textClips("a\n\nb\n\nc", 300, true), false, "three short paragraphs fit");
});

test("card-view: charts and code", () => {
  const [a, b] = barFractions([{ values: [182, 640, 1310] }, { values: [96, 301, 512] }]);
  assert.ok(Math.max(...a, ...b) <= 0.78 + 1e-9 && a[2] > b[2]);
  const pts = linePoints([0, 40, 95, 812], { width: 300, height: 120 });
  assert.ok(pts.every(p => p.x >= 0 && p.x <= 300 && p.y >= 0 && p.y <= 120));
  assert.equal(pts.at(-1)!.y, 10, "the last (largest) point is at the top margin");
  assert.deepEqual(codeLines("a\nb", "src/charge.ts:84-92").map(l => l.n), [84, 85]);
  assert.equal(diffTone("+ added"), "add"); assert.equal(diffTone("--- a/file"), null);
  assert.equal(fileKind({ url: "https://example.com/x" }), "page");
  assert.equal(fileKind({ path: "out/report.md" }), "markdown");
  assert.equal(shownAddress("https://example.com/flame?token=abc"), "example.com/flame");
  assert.equal(bytesLabel(18 * 1024), "18 KB");
});

test("card-view: order is newest first on open, then stable; a question points at a card", () => {
  const cards = [{ id: "a", updatedAt: "2026-03-04T09:00:00Z" }, { id: "b", updatedAt: "2026-03-04T10:00:00Z" }];
  const first = stableOrder(null, cards);
  assert.deepEqual(first, ["b", "a"]);
  // a updates: it keeps its place; c is new: it comes first.
  assert.deepEqual(stableOrder(first, [{ id: "a", updatedAt: "2026-03-04T11:00:00Z" }, cards[1], { id: "c", updatedAt: "2026-03-04T10:30:00Z" }]), ["c", "b", "a"]);
  const asked = pointedCards([{ id: "Q1", links: [{ card: "renders" }] }, { id: "Q2", answer: { choice: "A" }, links: [{ card: "queue" }] }]);
  assert.deepEqual([...asked], [["renders", "Q1"]], "only an open question points");
  assert.ok(foldedBudget(true) > foldedBudget(false));
  const now = Date.parse("2026-03-04T10:00:00Z");
  assert.equal(freshLabel("updated", "", "2026-03-04T09:35:00Z", now), "Updated 25 m ago");
  assert.equal(freshLabel("stale", "agent idle · 3 h", "2026-03-04T06:00:00Z", now), "agent idle · 3 h");
  assert.equal(freshLabel("updated", "", "2026-03-04T09:59:58Z", now), "Updated just now", "never \"0 s ago\"");
  assert.equal(freshLabel("stale", "agent idle · 0 s", "2026-03-04T09:59:58Z", now), "agent idle · just now");
});

test("card-md: Markdown without HTML; only http(s) links are links", () => {
  const md = parseMd("All **six** slides, `code` and [the page](https://example.com/p).\n\n- one\n- two\n\n<script>alert(1)</script> [x](javascript:alert(1))");
  assert.equal(md[0].kind, "p");
  assert.ok(md[0].runs.some(r => r.bold && r.text === "six") && md[0].runs.some(r => r.code && r.text === "code") && md[0].runs.some(r => r.url === "https://example.com/p"));
  assert.deepEqual(md.filter(b => b.kind === "li").map(b => b.runs[0].text), ["one", "two"]);
  const last = md.at(-1)!;
  assert.ok(last.runs.every(r => !r.url), "javascript: is never a link");
  assert.ok(last.runs.map(r => r.text).join("").includes("<script>"), "raw HTML stays text");
  assert.deepEqual(inline("see https://example.com/a.").map(r => [r.text, r.url ?? null]), [["see ", null], ["https://example.com/a", "https://example.com/a"], [".", null]]);
});

test("card freshness: a running agent's card keeps its running cells live, never \"agent idle\"", () => {
  const card = { updatedAt: "2026-03-04T09:00:00Z", keep: false, blocks: [{ type: "table", columns: ["", "Chrome"], rows: [["macOS", { state: "running" }]] }] } as never;
  const now = Date.parse("2026-03-04T10:00:00Z");
  // The agent started this turn after the card was last shown: still working, so not stale.
  assert.equal(freshness(card, { running: true, since: Date.parse("2026-03-04T09:30:00Z") }, now).kind, "updated");
  assert.equal(freshness(card, { running: false, since: Date.parse("2026-03-04T09:30:00Z") }, now).kind, "stale");
  assert.equal(freshness(card, null, now).label, "agent gone");
});
