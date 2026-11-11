import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Tom (2026-11-11): "I can't mark the text on these panels" — the reviewers card ("#102 has no reviewers yet", its facts,
// its source line) and the "Earlier ask, the agent kept going" row. Root cause: react-native-web sets user-select on a
// Text only when `selectable` is passed; otherwise the text inherits it, and Paseo's containers (gesture-handler views,
// headers) set user-select: none. Follow-up passed `selectable` in a dozen places, so almost nothing could be copied.
// The class fix: Follow-up's own Text (client/text.tsx) is selectable on web unless it labels a control, and its own
// Pressable marks a control by its role, so buttons, chips and pills stay tap- and drag-friendly.

const ROOT = join(import.meta.dirname, "..");
const sources = async () => {
  const files = (await readdir(join(ROOT, "client"))).filter(f => /\.tsx?$/.test(f)).map(f => `client/${f}`);
  return Promise.all([...files, "index.client.tsx"].map(async f => ({ f, text: await readFile(join(ROOT, f), "utf8") })));
};

test("selectableFor: content is selectable on web, control labels aren't, an explicit prop wins, native is unchanged", async () => {
  const { selectableFor, CONTROL_ROLES } = await import("../client/text-rules");
  assert.equal(selectableFor(undefined, false, "web"), true, "content text on web and desktop");
  assert.equal(selectableFor(undefined, true, "web"), false, "a button's label");
  assert.equal(selectableFor(false, false, "web"), false);
  assert.equal(selectableFor(true, true, "web"), true);
  assert.equal(selectableFor(undefined, false, "ios"), undefined, "native keeps its own default, so long-press still works");
  for (const role of ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem"]) assert.ok(CONTROL_ROLES.has(role), role);
});

test("every Text and Pressable in Follow-up is its own (client/text.tsx), never react-native's directly", async () => {
  for (const { f, text } of await sources()) {
    if (f === "client/text.tsx") continue;
    for (const m of text.matchAll(/import \{([^}]*)\} from "react-native"/g)) {
      const names = m[1].split(",").map(s => s.trim().replace(/^type\s+/, ""));
      assert.ok(!names.includes("Text"), `${f}: imports Text from react-native; use ./text so content stays selectable`);
      assert.ok(!names.includes("Pressable"), `${f}: imports Pressable from react-native; use ./text so control labels stay unselectable`);
      assert.ok(!names.some(n => /^Touchable/.test(n)), `${f}: a Touchable* bypasses the control rule`);
    }
  }
});

test("no content text is switched off by hand, and no control wraps content text", async () => {
  for (const { f, text } of await sources()) {
    if (f === "client/text.tsx") continue;
    assert.doesNotMatch(text, /selectable=\{false\}/, `${f}: selectable={false} by hand; a control's label gets it from its Pressable role`);
    // A button/link/tab/menu-item Pressable around RichText (the content renderer) would make that content uncopyable.
    // Titles in tappable rows use RichText's `plain` mode, which is a label. A radio or checkbox option card's text is
    // its label (you tap it to pick), so it is the one control allowed to carry RichText.
    const lines = text.split("\n");
    let depth = 0; let control = 0;
    for (const [i, line] of lines.entries()) {
      for (const tok of line.matchAll(/<Pressable\b[^>]*?(accessibilityRole|role)="(\w+)"|<Pressable\b|<\/Pressable>|<RichText\b(?![^>]*\bplain\b)/g)) {
        if (tok[0] === "</Pressable>") { if (control && control === depth) control = 0; depth--; continue; }
        if (tok[0].startsWith("<Pressable")) { depth++; if (!control && tok[2] && ["button", "link", "tab", "menuitem"].includes(tok[2])) control = depth; continue; }
        assert.ok(!control, `${f}:${i + 1}: content RichText inside a ${"control"} Pressable can't be selected`);
      }
    }
  }
});
