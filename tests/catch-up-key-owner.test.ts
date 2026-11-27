// every-catch-up-key-works-wherever-focus-is (AGENTS.md invariant 50). Tom, 2.2.0-beta.4, desktop: "The keyboard
// shortcuts on the catch up page in desktop don't work consistently". Follow-up's own list keys (useListKeys) listen on
// the document in the capture phase and stop j and k when a list owns them, so a Catch up listening on the document in
// the bubble phase never saw them; and Catch up found its controls with document.querySelector, so a second Catch up
// Paseo keeps mounted behind a tab took the clicks. The browser walk is scripts/screenshots.mjs --only catch-up
// --shot '^cu-keys-check' (catch-up-keys.json).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ownsKey, surfaceVisible } from "../shared/list-keys";

const source = () => readFile(new URL("../client/catch-up.tsx", import.meta.url), "utf8");

test("Catch up's keys are the window's, in the capture phase, so no document listener can stop them first", async () => {
  const s = await source();
  assert.match(s, /win\.addEventListener\("keydown", onKey, true\)/, "listens on the window, capture phase");
  assert.doesNotMatch(s, /(doc|document)\.addEventListener\("keydown"/, "never on the document, where list keys run first");
  assert.match(s, /e\.stopPropagation\(\);\s*\};\s*win\.addEventListener/, "a key it acts on goes no further");
  const lists = await readFile(new URL("../client/list-keys.ts", import.meta.url), "utf8");
  assert.match(lists, /doc\.addEventListener\("keydown", onKey, true\)/, "the list keys it must run before are the document's");
});

test("Catch up finds every control inside its own root, never the first one in the page", async () => {
  const s = await source();
  const keys = s.slice(s.indexOf("const rootRef = useRef"), s.indexOf("win.removeEventListener"));
  assert.ok(keys.length > 500, "the key handler is where it was");
  assert.doesNotMatch(keys, /(doc|document)\.querySelector/, "a Catch up kept mounted behind a tab would take the click");
  assert.match(s, /<View ref=\{rootRef\}/, "the root is the screen's outer view");
});

test("Catch up takes a key only when focus is inside it, or on nothing while it is on screen", async () => {
  const s = await source();
  assert.match(s, /ownsKey\(\{ inside: !!el && scopes\(\)\.some\(s => s\.contains\(el\)\), onBody, claimBody: true, visible: onBody && surfaceVisible\(r, doc\) \}\)/);
  // The rule itself: inside always; the page itself only while visible; focus elsewhere (Paseo's sidebar, a list) never.
  assert.equal(ownsKey({ inside: true, onBody: false, claimBody: true, visible: false }), true);
  assert.equal(ownsKey({ inside: false, onBody: true, claimBody: true, visible: true }), true);
  assert.equal(ownsKey({ inside: false, onBody: true, claimBody: true, visible: false }), false, "kept mounted behind a tab");
  assert.equal(ownsKey({ inside: false, onBody: false, claimBody: true, visible: true }), false, "focus in another surface keeps its keys");
  assert.equal(surfaceVisible({ checkVisibility: () => false }, { visibilityState: "visible" }), false);
});
