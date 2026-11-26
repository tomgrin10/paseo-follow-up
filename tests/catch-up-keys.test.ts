import { normalizeCombos } from "../shared/paseo-keys";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATCH_UP_KEYS, catchUpKey, keyLabel, type KeyPress } from "../shared/catch-up";
import { PASEO_BOUND, SEARCH_SHORTCUTS, shortcutCombos } from "../shared/search-key";

// Tom, 2026-11-17: "Keyboard shortcuts are important": every Catch up action has a key, and the keys never collide
// with Paseo's or Home's.
const ROOT = join(import.meta.dirname, "..");
const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({ key, meta: false, ctrl: false, alt: false, shift: false, mac: true, ...extra });
const idle = { typing: false, inMore: false, moreOpen: false, inRail: false };

test("no Catch up key is a combo Paseo binds, Home's search key, or a search-from-anywhere preset", () => {
  const paseo = new Set(normalizeCombos(PASEO_BOUND));
  const presets = new Set(normalizeCombos(SEARCH_SHORTCUTS.flatMap(shortcutCombos)));
  for (const k of CATCH_UP_KEYS) for (const combo of normalizeCombos(k.combos)) {
    assert.ok(!paseo.has(combo), `${k.key} (${k.what}) is Paseo's ${combo}`);
    assert.ok(!presets.has(combo), `${k.key} (${k.what}) is a search-from-anywhere preset`);
    assert.notEqual(combo, "/", "/ is Home's search key");
  }
  // Paseo's own ? and Esc stay Paseo's: the sheet is S and leaving is X.
  assert.equal(catchUpKey(press("?", { shift: true }), idle), null);
  assert.equal(catchUpKey(press("Escape"), idle), null);
  assert.equal(catchUpKey(press("Enter"), idle), null, "plain Enter stays the focused control's");
  assert.equal(catchUpKey(press(" "), idle), null, "Space stays Paseo's voice key");
  assert.deepEqual(catchUpKey(press("s"), idle), { action: "keys" });
  assert.deepEqual(catchUpKey(press("x"), idle), { action: "leave" });
});

test("within Catch up, no two actions share a key in the same place", () => {
  for (const when of [undefined, "more", "rail", "answer"] as const) {
    const seen = new Map<string, string>();
    for (const k of CATCH_UP_KEYS.filter(x => x.when === when)) for (const c of k.combos) {
      assert.ok(!seen.has(c) || seen.get(c) === k.action, `${c}: ${seen.get(c)} and ${k.action}`);
      seen.set(c, k.action);
    }
  }
});

test("every action in the list is reachable through catchUpKey, and the handler reads only the list's actions", () => {
  const reached = new Set<string>();
  const states = [idle, { ...idle, moreOpen: true }, { ...idle, inRail: true }, { ...idle, moreOpen: true, typing: true, inMore: true }, { ...idle, answer: true }];
  const keys = ["a", "h", "w", "j", "k", "m", "n", "l", "o", "r", "s", "x", "v", "1", "4", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Enter", "J", "D", "d", "t"];
  for (const at of states) for (const key of keys) for (const mods of [{}, { shift: true }, { meta: true }, { meta: true, shift: true }]) {
    const hit = catchUpKey(press(key, mods), at); if (hit) reached.add(hit.action);
  }
  for (const k of CATCH_UP_KEYS) assert.ok(reached.has(k.action), `${k.key} (${k.action}) has no key`);
});

test("keys never fire while typing, except More context's ask; ⌘↵ follows the platform's modifier", () => {
  const typing = { ...idle, typing: true };
  for (const key of ["a", "j", "x", "s", "ArrowRight"]) assert.equal(catchUpKey(press(key), typing), null);
  assert.equal(catchUpKey(press("Enter", { meta: true }), typing), null, "a card field's ⌘↵ is its SubmitScope's");
  assert.deepEqual(catchUpKey(press("Enter", { meta: true }), { ...typing, moreOpen: true, inMore: true }), { action: "ask" });
  assert.equal(catchUpKey(press("Enter", { meta: true, shift: true }), { ...typing, moreOpen: true, inMore: true }), null, "one Ask: no second target key");
  assert.deepEqual(catchUpKey(press("Enter", { meta: true }), idle), { action: "send" });
  assert.equal(catchUpKey(press("Enter", { ctrl: true }), idle), null, "Ctrl+Enter isn't Send on a Mac");
  assert.deepEqual(catchUpKey(press("Enter", { ctrl: true, mac: false }), idle), { action: "send" });
  assert.equal(catchUpKey(press("j", { meta: true }), idle), null, "⌘J is the browser's");
  assert.deepEqual(catchUpKey(press("B"), idle), { action: "pick", arg: "B" });
  assert.equal(catchUpKey(press("B", { shift: true }), idle), null);
  assert.deepEqual(catchUpKey(press("J", { shift: true }), idle), { action: "skip-workspace" }, "⇧J skips the workspace");
  assert.deepEqual(catchUpKey(press("j"), idle), { action: "skip" }, "J skips the card");
  assert.equal(catchUpKey(press("J", { shift: true }), typing), null);
  assert.deepEqual(catchUpKey(press("2"), { ...idle, moreOpen: true }), { action: "chip", arg: "2" });
  assert.equal(catchUpKey(press("2"), idle), null, "digits are More context's only while it is open");
  assert.deepEqual(catchUpKey(press("ArrowDown"), { ...idle, inRail: true }), { action: "rail-down" });
  assert.equal(catchUpKey(press("ArrowDown"), idle), null, "outside the queue the arrows scroll the card");
  // An answer card (Your questions): D, W and T are Done, Reply and Make a task; elsewhere D picks and W writes.
  const answer = { ...idle, answer: true };
  assert.deepEqual(catchUpKey(press("d"), answer), { action: "done" });
  assert.deepEqual(catchUpKey(press("w"), answer), { action: "reply" });
  assert.deepEqual(catchUpKey(press("t"), answer), { action: "task" });
  assert.deepEqual(catchUpKey(press("o"), answer), { action: "chat" });
  assert.deepEqual(catchUpKey(press("j"), answer), { action: "skip" });
  assert.deepEqual(catchUpKey(press("d"), idle), { action: "pick", arg: "D" });
  assert.equal(catchUpKey(press("t"), idle), null);
  assert.equal(catchUpKey(press("d"), { ...answer, typing: true }), null, "never while typing a reply");
});

test("Home's own keys are off while Catch up shows: its list isn't mounted and / doesn't reach for its search", async () => {
  const home = await readFile(join(ROOT, "client/home.tsx"), "utf8");
  assert.match(home, /useSlashToFocus\(omnibox, params\.view !== "log" && params\.view !== "catchup" && params\.view !== "stats" && params\.view !== "queue"\)/, "/ never reaches for Home's search under Catch up, the log, PR stats or the Linear queue");
  assert.match(home, /if \(params\.view === "catchup"\) return <View/, "Catch up replaces Home's list, so the list walk's keys aren't mounted");
  const screen = await readFile(join(ROOT, "client/catch-up.tsx"), "utf8");
  assert.match(screen, /S keys · X leave/, "the hint line names the sheet and Leave keys");
  for (const label of ["Leave ${MODE.name} (X)", "Back (K or ←)", "Later (L)", "Open chat (O)", "More context (M)", "${skipCardHint(noun)} (J or →)", "${skipWorkspaceHint(wsLeft)} (⇧J)", "Close the keys (S)"]) assert.ok(screen.includes(label), `tooltip ${label}`);
});

test("the keys read as this platform spells them: ⌘ on a Mac, Ctrl elsewhere, as Send's own hint does", () => {
  assert.equal(keyLabel("⌘↵", true), "⌘↵");
  assert.equal(keyLabel("⌘↵", false), "Ctrl ↵");
  assert.equal(keyLabel("⌘⇧↵", false), "Ctrl ⇧↵");
  assert.equal(keyLabel("J / →", false), "J / →");
});

test("R lands on the card on screen, not the top of the queue", async () => {
  const screen = await readFile(join(ROOT, "client/catch-up.tsx"), "utf8");
  assert.match(screen, /dataSet: here \? \{ catchUpHere: "1" \}/, "the rail marks the card on screen");
  assert.match(screen, /\[data-catch-up-rail\] \[data-catch-up-here\]/, "R focuses that mark");
});
