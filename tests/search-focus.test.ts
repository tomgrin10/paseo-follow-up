import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSearchFocus, TYPE_AHEAD_MS, type FocusField } from "../shared/search-focus";

/**
 * every-search-request-lands-in-the-visible-search (2026-11-25, the developer: "sometimes cmd+shift+k goes to the
 * follow up homepage but not the search bar, make sure it always goes to the search bar"). Every way to ask for
 * Home's search (the search key, ⌘K "Follow-up: Search", `/`) ends with the caret in the search field on screen,
 * whatever was mounted, loading or focused before.
 *
 * Main kept one global "pending" flag that the first mounted search field took on its next effect: Paseo keeps an
 * earlier Home mounted, hidden, behind the chat, so that one took the flag and focused a hidden input; Catch up, PR
 * stats, the queue and the log share Home's route, so the key there only bumped the flag and no field was drawn to
 * take it; and the search remounts when the Overseer's status arrives, dropping a caret it had just taken.
 */

/** A stand-in for a mounted search field and the one caret on the page. */
function page() {
  let caret: Field | null = null;
  type Field = FocusField & { visible: boolean; mounted: boolean; name: string };
  const field = (name: string, visible = true): Field => {
    const f: Field = { name, visible, mounted: true, shown: () => f.mounted && f.visible, focused: () => caret === f, focus: () => { if (f.mounted && f.visible) caret = f; } };
    return f;
  };
  return { field, caret: () => caret?.name ?? null, steal: (to: string | null) => { caret = to ? field(to) : null; } };
}

test("a Home kept mounted behind the chat never takes the caret; the one on screen does", () => {
  const p = page(); const focus = createSearchFocus();
  const behind = p.field("behind", false); focus.register(behind);
  assert.equal(focus.request(), false, "nothing on screen yet");
  const front = p.field("front"); focus.register(front);
  assert.equal(p.caret(), "front");
});

test("a request made while Home is loading is taken by the field that mounts later", () => {
  const p = page(); const focus = createSearchFocus();
  focus.request();
  assert.equal(p.caret(), null);
  focus.register(p.field("home"));
  assert.equal(p.caret(), "home");
});

test("a field mounted hidden takes the request when it lays out on screen", () => {
  const p = page(); const focus = createSearchFocus();
  const home = p.field("home", false); focus.register(home);
  focus.request();
  assert.equal(p.caret(), null);
  home.visible = true; focus.changed();
  assert.equal(p.caret(), "home");
});

test("a remount takes the caret back until the developer acts", () => {
  const p = page(); const focus = createSearchFocus();
  const home = p.field("home"); focus.register(home);
  focus.request();
  assert.equal(p.caret(), "home");
  p.steal(null); focus.changed();
  assert.equal(p.caret(), "home", "the field remounted and laid out");
  focus.cancel();
  p.steal("a-row-the-developer-clicked"); focus.changed();
  assert.equal(p.caret(), "a-row-the-developer-clicked", "the developer's own move stands");
});

test("a dialog over the search: the request waits, never fights it, and lands when the dialog hands focus back", () => {
  const p = page(); const focus = createSearchFocus();
  let dialog = true;
  const home = Object.assign(p.field("home"), { covered: () => dialog });
  focus.register(home);
  assert.equal(focus.request(), false, "⌘K's palette is still drawn over Home");
  p.steal("palette-input"); focus.focusMoved({ dialog: true, search: false });
  assert.equal(p.caret(), "palette-input", "no focus fight with the dialog");
  dialog = false; p.steal("what-the-palette-restored"); focus.focusMoved({ dialog: false, search: false });
  assert.equal(p.caret(), "home");
});

test("after landing, a focus move elsewhere is taken back once; the next is the developer's (a screen reader's cursor)", () => {
  const p = page(); const focus = createSearchFocus();
  focus.register(p.field("home"));
  focus.request();
  p.steal("virtual-cursor-1"); focus.focusMoved({ dialog: false, search: false });
  assert.equal(p.caret(), "home", "taken back once");
  p.steal("virtual-cursor-2"); focus.focusMoved({ dialog: false, search: false });
  assert.equal(p.caret(), "virtual-cursor-2", "never stuck in the search");
  assert.equal(focus.wanted(), false);
});

test("a focus() inside a delivery doesn't deliver again (no focusin recursion)", () => {
  const focus = createSearchFocus();
  let calls = 0; let caret = false;
  focus.register({ shown: () => true, focused: () => caret, focus: () => { calls++; focus.focusMoved({ dialog: false, search: false }); caret = true; } });
  focus.request();
  assert.equal(calls, 1);
});

test("Catch up, or a phone's row detail on Home's route (no search drawn), holds the request until Home's list draws its search", () => {
  const p = page(); const focus = createSearchFocus();
  focus.register(p.field("catch-up-home-instance", false));
  assert.equal(focus.request(), false);
  assert.equal(focus.shown(), false, "so the caller opens Home's list");
  focus.register(p.field("home-list"));
  assert.equal(p.caret(), "home-list");
});

test("a second request on Home moves the caret back to the search", () => {
  const p = page(); const focus = createSearchFocus();
  focus.register(p.field("home"));
  focus.request(); focus.cancel();
  p.steal("a-button");
  assert.equal(focus.request(), true);
  assert.equal(p.caret(), "home");
});

test("an unmounted field is forgotten; the newest shown field wins", () => {
  const p = page(); const focus = createSearchFocus();
  const a = p.field("a"); const offA = focus.register(a);
  const b = p.field("b"); focus.register(b);
  focus.request();
  assert.equal(p.caret(), "b");
  focus.cancel(); offA();
  b.mounted = false;
  assert.equal(focus.shown(), false);
});

test("characters typed before the caret lands become the query; after it lands they are the field's own", () => {
  const p = page(); const focus = createSearchFocus();
  let query = "";
  const home = Object.assign(p.field("home", false), { type: (t: string) => { query = t; } });
  focus.register(home);
  focus.request();
  for (const k of ["a", "c", "x"]) assert.equal(focus.typeAhead(k), true);
  assert.equal(focus.typeAhead("Backspace"), true);
  assert.equal(focus.typeAhead("Backspace"), true);
  assert.equal(focus.typeAhead("Backspace"), true);
  assert.equal(focus.typeAhead("Backspace"), false, "nothing left to erase: Backspace is the developer's again");
  for (const k of ["a", "c", "m", "e"]) focus.typeAhead(k);
  home.visible = true; focus.changed();
  assert.equal(p.caret(), "home");
  assert.equal(query, "acme");
  assert.equal(focus.typeAhead("x"), false, "landed: the field types for itself");
});

test("a cancelled request drops what was typed ahead, and a new request starts empty", () => {
  const p = page(); const focus = createSearchFocus();
  let query = "";
  const home = Object.assign(p.field("home", false), { type: (t: string) => { query = t; } });
  focus.register(home);
  focus.request(); focus.typeAhead("a"); focus.cancel();
  assert.equal(focus.typeAhead("b"), false, "no request held");
  focus.request(); focus.typeAhead("z");
  home.visible = true; focus.changed();
  assert.equal(query, "z");
});

test("type-ahead lasts TYPE_AHEAD_MS: if no search came on screen by then, a key is the developer's again", () => {
  let t = 1000;
  const p = page(); const focus = createSearchFocus(() => t);
  focus.register(p.field("never-shown", false));
  focus.request();
  assert.equal(focus.typeAhead("a"), true);
  t += TYPE_AHEAD_MS + 1;
  assert.equal(focus.typeAhead("b"), false, "the caller then ends the request: the keys are no longer eaten");
});

const root = join(import.meta.dirname, "..");
test("every way to ask goes through the one owner: no global flag, no timer, no route-only shortcut", async () => {
  const key = await readFile(join(root, "client/search-key.ts"), "utf8");
  const entry = await readFile(join(root, "index.client.tsx"), "utf8");
  const chrome = await readFile(join(root, "client/home-chrome.tsx"), "utf8");
  const view = await readFile(join(root, "client/home-view.ts"), "utf8");
  assert.match(key, /requestSearch\(open\.focus,/, "the search key");
  assert.match(entry, /`Follow-up: Search[\s\S]{0,400}requestSearch\(extras\.searchFocus,/, "⌘K Follow-up: Search");
  assert.match(chrome, /if \(omnibox\.focusSearch\(\)\) e\.preventDefault\(\)/, "`/` asks only when a Home search is on screen");
  assert.match(chrome, /useSearchFocusField\(sources\.extras\.searchFocus, inputRef, setQuery\)/, "typed-ahead characters become the query");
  assert.equal((chrome.match(/onLayout=\{omnibox\.onSearchLayout\}/g) ?? []).length, 2, "both search layouts retry on layout");
  for (const [name, src] of [["search-key", key], ["home-view", view], ["home-chrome", chrome]] as const) {
    assert.doesNotMatch(src, /takeFocus|focusToken|onHomeRoute/, `${name}: main's one-shot flag and route check are gone`);
  }
  assert.doesNotMatch(key, /requestAnimationFrame|setTimeout/, "no timer");
  const adapter = await readFile(join(root, "client/search-focus.ts"), "utf8");
  assert.doesNotMatch(adapter, /setTimeout|setInterval|requestAnimationFrame/, "no timer or retry loop");
  assert.match(adapter, /surfaceVisible\(/, "shown means laid out on the visible page");
  assert.match(adapter, /overlayOver\(/, "a menu or modal over the search makes the request wait");
  assert.match(adapter, /"pointerdown", "click", "wheel", "touchstart", "input"/, "every way the developer acts ends the request");
  assert.match(adapter, /addEventListener!\("keydown", onKey/, "a key ends it unless it is the request's own (keyActs)");
  assert.match(adapter, /\(pointer: coarse\)/, "a touch screen never gets an unasked focus()");
  // The route never decides: Catch up, PR stats, the queue and the log share Home's route, and a phone's Home route can
  // show a row's detail; Home's list opens whenever no Home search is on screen.
  assert.match(adapter, /if \(!owner\.shown\(\)\) open\(\);/);
});
