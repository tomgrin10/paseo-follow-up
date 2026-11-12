import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fitImage } from "../shared/image-fit";

const source = (file: string) => readFile(join(import.meta.dirname, "..", "client", file), "utf8");

// rc.1: a screenshot in the notes opened a browser tab. A tap shows it in Follow-up's own viewer, never a URL opener.
test("a notes screenshot tap never calls a URL opener", async () => {
  for (const file of ["release-notes.tsx", "image-viewer.tsx"]) {
    const s = await source(file);
    assert.doesNotMatch(s, /openExternalUrl|Linking\b|window\.open|\bhref=|openURL/, `${file} must not open a URL`);
  }
  const notes = await source("release-notes.tsx");
  assert.match(notes, /role="button"[\s\S]{0,200}onPress=\{\(\) => \{ if \(viewer\) viewer\(image, self\.current\); else setOwn\(true\); \}\}/, "the tap opens the image viewer");
});

test("the notes dialog's close shuts the viewer first", async () => {
  const notes = await source("release-notes.tsx");
  assert.match(notes, /const dismiss = \(\) => \{ if \(viewing\) closeViewer\(\); else onClose\(\); \};/);
  assert.match(notes, /onOpenChange=\{next => \{ if \(!next\) dismiss\(\); \}\}/, "the host's Esc and backdrop go through dismiss");
  assert.match(notes, /onDismiss=\{dismiss\}/, "the wide dialog too");
});

test("the viewer fits the window and never draws an image past its CSS width", () => {
  // Home (1120 CSS px wide, 16:10) on a 2560x1440 window: its own size, not stretched.
  assert.deepEqual(fitImage({ width: 1120, aspect: 1120 / 700 }, { width: 2560, height: 1440 }), { width: 1120, height: 700, phone: false });
  // On 1440x900 it fits the height less the margins.
  const home = fitImage({ width: 1120, aspect: 1120 / 700 }, { width: 1440, height: 900 });
  assert.ok(home.width <= 1440 - 112 && home.height <= 900 - 112, JSON.stringify(home));
  // The tall panel (320x910) on a phone fits the height, at its shape.
  const panel = fitImage({ width: 320, aspect: 320 / 910 }, { width: 390, height: 844 });
  assert.equal(panel.phone, true); assert.ok(panel.height <= 844 - 84 && panel.width <= 320);
  assert.ok(Math.abs(panel.width / panel.height - 320 / 910) < 0.01);
  // Unknown CSS width: fit the window.
  assert.equal(fitImage({ width: null, aspect: 2 }, { width: 1000, height: 2000 }).width, 1000 - 112);
});

// Tom on rc.2: the notes' scrollbar must show whenever they overflow, not only while scrolling (macOS hides overlay
// scrollbars unless the container styles them). Scoped to the notes' scroll container, never global.
test("the notes' scroll container keeps a styled, scoped scrollbar in every dialog", async () => {
  const { notesScrollbarCss, NOTES_SCROLL_ATTR } = await import("../shared/notes-scrollbar");
  const notes = await source("release-notes.tsx");
  assert.equal((notes.match(/<NotesScroll theme=\{theme\}/g) ?? []).length, 3, "the wide dialog, the host dialog and the phone sheet");
  assert.doesNotMatch(notes, /<ScrollView style/, "no notes body scrolls without NotesScroll");
  assert.match(notes, /persistentScrollbar/, "Android keeps its bar");
  const css = notesScrollbarCss({ foregroundMuted: "#888888" });
  for (const line of css.split("\n")) assert.ok(line.includes(`[${NOTES_SCROLL_ATTR}]`), `scoped: ${line}`);
  assert.match(css, /::-webkit-scrollbar \{[^}]*width: 10px/); assert.match(css, /::-webkit-scrollbar-thumb \{[^}]*#888888/);
  assert.match(css, /scrollbar-color: [^;]*#888888/);
});

test("the notes' titles name the plugin from its manifest", async () => {
  const notes = await source("release-notes.tsx");
  assert.match(notes, /export const notesTitle = \(name: string, version: string \| null\) => version \? `What's new in \$\{name\} \$\{version\}` : `\$\{name\} release notes`;/);
  assert.match(notes, /const title = notesTitle\(name, full \? null : newest\.version\);/);
  assert.equal((notes.match(/<WhatsNewSheet open name=\{view\.name\}/g) ?? []).length, 2, "What's new and Settings' Release notes");
  const server = await readFile(join(import.meta.dirname, "..", "server", "release-notes.ts"), "utf8");
  assert.match(server, /paseo-plugin\.json/);
});
