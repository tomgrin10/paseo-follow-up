import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REVEAL_GAP, revealPlan, roomOverlap } from "../client/dock";

// 2026-11-27, the developer on a phone: "when writing something, for example in the overseer, the keyboard opens over
// the text area. Usually, the text area goes up to be above the keyboard." Root cause: Paseo moves its own composer
// above the keyboard and positions fields in its sheets, but its app draws edge to edge, so the window never shrinks
// for the keyboard and a plugin's screens and panels get nothing. DockedPane's native branch assumed the host kept the
// pane above the keyboard and padded by 0, and the other screens had no handling at all; half the fields were plain
// react-native TextInputs. Invariant `the-keyboard-never-covers-a-field`: every field is client/field.tsx's Field,
// every surface draws inside a KeyboardRoom (client/keyboard.tsx), which stops above the keyboard and brings the
// focused field into view.

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFile(join(ROOT, f), "utf8");
const clientFiles = async () => [
  "index.client.tsx",
  ...(await readdir(join(ROOT, "client"))).filter(f => /\.tsx?$/.test(f)).map(f => `client/${f}`),
];

test("the-keyboard-never-covers-a-field: every text field in the client is Field, the one shared field", async () => {
  const bad: string[] = [];
  for (const f of await clientFiles()) {
    if (f === "client/field.tsx") continue;
    const s = await read(f);
    // A TextInput rendered, or imported as a value (types are fine), from react-native or the SDK.
    if (/<TextInput\b(?!\s*[|>])/.test(s)) bad.push(`${f}: renders <TextInput>`);
    for (const m of s.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(react-native|@getpaseo\/plugin\/client\/ui)"/g))
      if (m[1].split(",").some(n => /^\s*TextInput\b/.test(n))) bad.push(`${f}: imports TextInput from ${m[2]}`);
  }
  assert.deepEqual(bad, [], "use Field (client/field.tsx) so the field reports focus to its KeyboardRoom");
  const field = await read("client/field.tsx");
  assert.match(field, /import \{ TextInput \} from "@getpaseo\/plugin\/client\/ui"/, "Field is the SDK's TextInput, so Paseo still positions it in sheets");
  assert.match(field, /room\?\.focus\(/);
});

test("the-keyboard-never-covers-a-field: every screen, panel and settings screen draws inside a KeyboardRoom", async () => {
  const s = await read("index.client.tsx");
  for (const name of ["Settings", "Overview", "Panel", "ViewTab", "Large"]) {
    const m = s.match(new RegExp(`const ${name} = \\(props: [^)]*\\) => (<[A-Za-z]+)`));
    assert.ok(m, `${name} is defined`);
    assert.equal(m![1], "<KeyboardRoom", `${name}'s surface draws inside a KeyboardRoom`);
  }
  // Every registered surface is one of those.
  for (const m of s.matchAll(/client\.(addScreen|addWorkspacePanel)\(\{[^}]*Component: (\w+)/g))
    assert.ok(["Settings", "Overview", "Panel", "ViewTab", "Large"].includes(m[2]), `${m[1]} registers ${m[2]}, which isn't in a KeyboardRoom`);
  assert.match(await read("client/settings-screens.ts"), /createElement\(Screen/, "settings screens render the Settings surface");
  // The docked pane is a room too: setup draws it in a sheet, outside any surface's room.
  assert.match(await read("client/docked-pane.tsx"), /<KeyboardRoom compact=\{compact\}/);
});

test("the-keyboard-never-covers-a-field: native reads the keyboard's top edge, never assumes the host moved the page", async () => {
  const k = await read("client/keyboard.tsx");
  assert.match(k, /endCoordinates\.screenY/);
  assert.doesNotMatch(await read("client/docked-pane.tsx"), /Keyboard\.addListener|overlap: 0/, "one keyboard reader, client/keyboard.tsx");
});

test("a room stops above the keyboard by what it covers of the room, and nothing when the host already moved it", () => {
  assert.equal(roomOverlap(844, 508), 336, "a full-height screen under a 336-tall keyboard");
  assert.equal(roomOverlap(800, 508), 292, "a screen above the home indicator");
  assert.equal(roomOverlap(500, 508), 0, "the host already shrank or moved it");
  assert.equal(roomOverlap(844, null), 0, "no keyboard");
  assert.equal(roomOverlap(null, 508), 0, "not measured yet");
});

test("a field that shows above the keyboard moves nothing", () => {
  assert.deepEqual(revealPlan({ fieldTop: 400, fieldBottom: 446, keyboardTop: 508, room: 0 }), { scrollTo: null, lift: 0 });
  assert.deepEqual(revealPlan({ fieldTop: 400, fieldBottom: 446, keyboardTop: 508, room: 96, scroll: { top: 60, bottom: 508, offset: 0, maxOffset: 900 } }), { scrollTo: null, lift: 0 });
});

test("a covered field in a scroll view scrolls up, keeping room for its Send", () => {
  // Field 700-746, keyboard at 508; the scroll view ends at the keyboard. Room 96 below the field.
  const p = revealPlan({ fieldTop: 700, fieldBottom: 746, keyboardTop: 508, room: 96, scroll: { top: 60, bottom: 508, offset: 100, maxOffset: 900 } });
  assert.deepEqual(p, { scrollTo: 100 + (746 - (508 - 96)), lift: 0 });
  const tight = revealPlan({ fieldTop: 700, fieldBottom: 746, keyboardTop: 508, room: 0, scroll: { top: 60, bottom: 508, offset: 0, maxOffset: 900 } });
  assert.equal(tight.scrollTo, 746 - (508 - REVEAL_GAP), "never flush against the keyboard");
});

test("what scrolling can't cover lifts the room, never past the field's top", () => {
  // Only 100 left to scroll: the rest lifts.
  const p = revealPlan({ fieldTop: 700, fieldBottom: 746, keyboardTop: 508, room: 0, scroll: { top: 60, bottom: 844, offset: 800, maxOffset: 900 } });
  assert.equal(p.scrollTo, 900);
  assert.equal(p.lift, 746 - 100 - (508 - REVEAL_GAP));
  // No scroll view (the Overseer's reply box under a host that didn't move the page): the room lifts it.
  assert.deepEqual(revealPlan({ fieldTop: 790, fieldBottom: 836, keyboardTop: 508, room: 0 }), { scrollTo: null, lift: 836 - (508 - REVEAL_GAP) });
  // A tall field: its top stays on screen.
  assert.equal(revealPlan({ fieldTop: 200, fieldBottom: 700, keyboardTop: 508, room: 0 }).lift, 200 - REVEAL_GAP);
});

test("a field scrolled above its scroll view's top comes back under the edge", () => {
  assert.deepEqual(revealPlan({ fieldTop: 20, fieldBottom: 66, keyboardTop: 508, room: 0, scroll: { top: 60, bottom: 508, offset: 300, maxOffset: 900 } }), { scrollTo: 300 - (60 + REVEAL_GAP - 20), lift: 0 });
});
