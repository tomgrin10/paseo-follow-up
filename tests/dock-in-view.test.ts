import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REVEAL_GAP, dockState, dockYields, keyboardOverlap, revealFocused, revealTarget, type DockNode } from "../client/dock";

// 2026-11-17, phone renders of Home's question card: after Something else (or Add note) opened its field, the card's
// Send sat under Home's dock (Sign off, Sign off & next, Later, and the reply box), and with the keyboard up the dock
// and the keyboard together covered the field too. Root cause: Home's detail pane drew its dock under a plain scroll
// view and hid the dock's Sign off row only while its own reply box had focus (`typing`); nothing brought a field
// that opened in the content, or its Send, into view, and nothing kept the pane above a keyboard that overlays the
// page. The Overseer's pane had the same dock with no handling at all, and setup hid its bar on a keyboard check of
// its own. Invariant `a-focused-field-and-its-send-stay-in-view`: every docked pane draws through DockedPane.

const ROOT = join(import.meta.dirname, "..");
const src = (f: string) => readFile(join(ROOT, f), "utf8");

/** A tiny DOM: form > row > textarea, inside a scroll view, with a record of what scrolled. */
function tree() {
  const scrolled: { node: string; block?: string }[] = [];
  const node = (name: string, parent: DockNode | null, extra: Partial<DockNode> = {}): DockNode & { name: string } =>
    ({ name, parentElement: parent, dataset: {}, scrollIntoView: o => scrolled.push({ node: name, block: o?.block }), ...extra });
  const scroll = node("scroll", null);
  const form = node("form", scroll, { dataset: { primaryForm: "1" } });
  const row = node("row", form);
  const field = node("field", row, { tagName: "TEXTAREA" });
  const loose = node("loose", scroll, { tagName: "INPUT" });
  return { scrolled, form, field, loose, button: node("button", form, { tagName: "BUTTON" }) };
}

test("a focused field brings its whole primary form (the field with its Send) into view, the least distance", () => {
  const t = tree();
  assert.equal(revealTarget(t.field), t.form);
  assert.equal(revealFocused(t.field), t.form);
  assert.deepEqual(t.scrolled, [{ node: "form", block: "nearest" }]);
});

test("a field outside a primary form brings itself into view; focus on a button scrolls nothing", () => {
  const t = tree();
  assert.equal(revealFocused(t.loose), t.loose);
  assert.equal(revealFocused(t.button), null, "only a field the keyboard types into moves the pane");
  assert.equal(revealFocused(null), null);
  assert.deepEqual(t.scrolled, [{ node: "loose", block: "nearest" }]);
});

test("the dock's extras step aside on a phone while any field in the pane has focus or the keyboard is up", () => {
  // The reported state: the question's own field focused, the reply box not. Main kept Sign off showing.
  assert.equal(dockYields({ compact: true, fieldFocused: true, keyboardUp: false }), true);
  assert.equal(dockYields({ compact: true, fieldFocused: false, keyboardUp: true }), true);
  assert.equal(dockYields({ compact: true, fieldFocused: false, keyboardUp: false }), false);
  assert.equal(dockYields({ compact: false, fieldFocused: true, keyboardUp: true }), false, "desktop keeps its layout");
});

test("typing in the content hides the whole dock, reply box included, so one text box is on screen", () => {
  assert.deepEqual(dockState({ compact: true, fieldFocused: true, fieldInDock: false, keyboardUp: true }), { yields: true, typingInContent: true });
  assert.deepEqual(dockState({ compact: true, fieldFocused: true, fieldInDock: true, keyboardUp: true }), { yields: true, typingInContent: false }, "typing a reply keeps the reply box");
  assert.deepEqual(dockState({ compact: false, fieldFocused: true, fieldInDock: false, keyboardUp: false }), { yields: false, typingInContent: false });
});

test("a revealed form keeps a gutter's gap from the dock and the header", () => {
  const style: { scrollMarginBottom?: string; scrollMarginTop?: string } = {};
  const form: DockNode = { dataset: { primaryForm: "1" }, style, scrollIntoView: () => undefined };
  revealFocused({ tagName: "TEXTAREA", parentElement: form });
  assert.deepEqual(style, { scrollMarginBottom: `${REVEAL_GAP}px`, scrollMarginTop: `${REVEAL_GAP}px` });
});

test("the keyboard's overlap: what it covers of an unchanged page, nothing when the page resized for it", () => {
  assert.equal(keyboardOverlap({ innerHeight: 844, viewportHeight: 508, offsetTop: 0 }), 336);
  assert.equal(keyboardOverlap({ innerHeight: 844, viewportHeight: 508, offsetTop: 40 }), 296, "a page scrolled under the keyboard");
  assert.equal(keyboardOverlap({ innerHeight: 508, viewportHeight: 508, offsetTop: 0 }), 0, "resizes-content: the pane already shrank");
});

test("a-focused-field-and-its-send-stay-in-view: every docked pane draws through DockedPane, and every answer form is marked", async () => {
  // A bar docked under a scroll view (a top border plus the phone's bottom inset) only ever as DockedPane's dock.
  const dir = join(ROOT, "client");
  const dock = /borderTopWidth: 1[^\n]*\}, (bottomInset|bottomPad)\(compact\)\]/g;
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".tsx"))) {
    const s = await readFile(join(dir, f), "utf8");
    for (const m of s.matchAll(dock)) {
      const before = s.slice(Math.max(0, m.index! - 200), m.index!);
      assert.match(before, /dock=\{[^\n]*$/, `${f}: a docked bar outside DockedPane's dock (client/docked-pane.tsx)`);
    }
  }
  const home = await src("client/home.tsx");
  assert.equal((home.match(/<DockedPane /g) ?? []).length, 2, "Home's detail pane and the Overseer's pane");
  assert.match(home, /\{!yields && moves\}/, "Sign off's row yields for any field, not only the reply box");
  assert.match(home, /dock=\{\(\{ yields, typingInContent \}\) => s\.agentId && !typingInContent && /, "typing an answer hides the reply box too");
  assert.doesNotMatch(home, /setTyping|!typing\b/, "no pane-local typing state decides the dock");
  // Catch up's phone card: its bar (Back, Context, Later, Open chat, Skip) under a scrolling card, the case #233 fixed.
  const catchUp = await src("client/catch-up.tsx");
  assert.equal((catchUp.match(/<DockedPane /g) ?? []).length, 1, "Catch up's card draws through DockedPane");
  assert.match(catchUp, /\{!yields && moves\}/, "the bar steps aside while a field has focus or the keyboard is up");
  assert.match(catchUp, /dock=\{\(\{ yields, typingInContent \}\) => compact && \(sheet && !typingInContent \|\| !yields\) && /, "an open sheet (More context, Later) stays above the keyboard; typing in the card hides it");
  assert.match(await src("client/more-context.tsx"), /<View \{\.\.\.PRIMARY_FORM\} style=\{\{ gap: 10 \}\}>\s*(?:<ImageField [^>]*>)?<Field accessibilityLabel="What do you want to know\?"/, "More context's ask box keeps its Ask buttons in view");
  assert.match(catchUp, /<View \{\.\.\.PRIMARY_FORM\}[^>]*>\s*<Field accessibilityLabel="Tell the agent something"/, "the note keeps its Send in view");
  // Setup's popup (setup-is-one-popup): its frame (client/setup-dialog.tsx) docks the moves on both layouts.
  const setup = await src("client/onboarding.tsx") + await src("client/setup-dialog.tsx");
  assert.match(setup, /dock=\{\(\{ yields \}\) => !yields && foot\}/, "on a phone the moves step aside while a field has focus");
  assert.doesNotMatch(setup, /useKeyboardUp/, "setup reads the keyboard through DockedPane");
  // The forms: QuestionBody's field with its actions (both layouts), and the brief card's answer and note fields.
  const questions = await src("client/questions.tsx");
  assert.equal((questions.match(/<View \{\.\.\.PRIMARY_FORM\}[^>]*>\s*\{(open && input|showInput && input)\}\s*\{actions\}/g) ?? []).length, 2);
  const brief = await src("client/brief.tsx");
  assert.match(brief, /isOther\(picks\[d\.id\]\) && <View \{\.\.\.PRIMARY_FORM\}/);
  assert.match(brief, /notesOpen\[d\.id\] \? <View \{\.\.\.PRIMARY_FORM\}/);
});
