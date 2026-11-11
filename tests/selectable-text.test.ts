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

test("an option card's description stays copyable: its letter and label are the control, its prose is content", async () => {
  const q = await readFile(join(ROOT, "client/questions.tsx"), "utf8");
  assert.match(q, /\{!!consequence && <RichText selectable=\{copyable\}/, "OptionCard's consequence opts back into selection");
});

/**
 * The ways a file can reach react-native's Text, Pressable or a Touchable* past client/text.tsx: a named import or
 * re-export in any shape (multi-line, aliased, single-quoted, after a default import), a namespace or default import
 * (`RN.Text`), or a require. Type-only names (TextProps, PressableProps) are fine.
 */
export function reactNativeBypasses(source: string): string[] {
  const found: string[] = [];
  const from = String.raw`from\s*(?:"react-native"|'react-native')`;
  for (const m of source.matchAll(new RegExp(String.raw`(?:import|export)\s+(?:type\s+)?(?:([\w$]+)\s*,\s*)?(?:\*\s+as\s+([\w$]+)\s+|\{([^}]*)\}\s*|([\w$]+)\s+)` + from, "g"))) {
    const [, defaultName, namespace, named, onlyDefault] = m;
    if (namespace || defaultName || onlyDefault) found.push(`the whole of react-native as ${namespace ?? defaultName ?? onlyDefault}`);
    for (const raw of (named ?? "").split(",")) {
      const spec = raw.trim();
      if (!spec || /^type\s/.test(spec)) continue;
      const name = spec.split(/\s+as\s+/)[0];
      if (name === "Text" || name === "Pressable" || /^Touchable/.test(name)) found.push(name);
    }
  }
  if (/require\(\s*['"]react-native['"]\s*\)/.test(source)) found.push("require(\"react-native\")");
  return found;
}

test("reactNativeBypasses catches every import shape, not just the one-line named import", () => {
  assert.deepEqual(reactNativeBypasses(`import { Platform, Text, View } from "react-native";`), ["Text"]);
  assert.deepEqual(reactNativeBypasses(`import {\n  Platform,\n  Text,\n  Pressable,\n} from "react-native";`), ["Text", "Pressable"]);
  assert.deepEqual(reactNativeBypasses(`import { Text as RNText } from 'react-native';`), ["Text"]);
  assert.deepEqual(reactNativeBypasses(`import { TouchableOpacity } from "react-native";`), ["TouchableOpacity"]);
  assert.deepEqual(reactNativeBypasses(`import * as RN from "react-native";`), ["the whole of react-native as RN"]);
  assert.deepEqual(reactNativeBypasses(`import RN, { View } from "react-native";`), ["the whole of react-native as RN"]);
  assert.deepEqual(reactNativeBypasses(`export { Text } from "react-native";`), ["Text"]);
  assert.deepEqual(reactNativeBypasses(`const { Text } = require("react-native");`), ['require("react-native")']);
  assert.deepEqual(reactNativeBypasses(`import { View, type TextProps, type PressableProps } from "react-native";`), []);
  assert.deepEqual(reactNativeBypasses(`import type { TextInput as NativeTextInput } from "react-native";`), []);
  assert.deepEqual(reactNativeBypasses(`import { Pressable, Text } from "./text";`), []);
});

test("every Text and Pressable in Follow-up is its own (client/text.tsx), never react-native's directly", async () => {
  for (const { f, text } of await sources()) {
    if (f === "client/text.tsx") continue;
    assert.deepEqual(reactNativeBypasses(text), [], `${f}: reaches react-native's Text/Pressable/Touchable directly; import Text and Pressable from ./text so content stays selectable and control labels don't`);
  }
});

test("no content text is switched off by hand, and no control wraps content text", async () => {
  for (const { f, text } of await sources()) {
    if (f === "client/text.tsx") continue;
    assert.doesNotMatch(text, /selectable=\{false\}/, `${f}: selectable={false} by hand; a control's label gets it from its Pressable role`);
    // A button/link/tab/menu-item Pressable around RichText (the content renderer) would make that content uncopyable.
    // Titles in tappable rows use RichText's `plain` mode, which is a label. A radio or checkbox option card is the one
    // control allowed to carry RichText: its label is what you tap to pick, and its description opts back into
    // selection (`copyable`). PressScale is a Pressable too.
    const lines = text.split("\n");
    let depth = 0; let control = 0;
    for (const [i, line] of lines.entries()) {
      for (const tok of line.matchAll(/<(?:Pressable|PressScale)\b[^>]*?(accessibilityRole|role)="(\w+)"|<(?:Pressable|PressScale)\b|<\/(?:Pressable|PressScale)>|<RichText\b(?![^>]*\bplain\b)/g)) {
        if (tok[0].startsWith("</")) { if (control && control === depth) control = 0; depth--; continue; }
        if (tok[0].startsWith("<Pressable") || tok[0].startsWith("<PressScale")) { depth++; if (!control && tok[2] && ["button", "link", "tab", "menuitem"].includes(tok[2])) control = depth; continue; }
        assert.ok(!control, `${f}:${i + 1}: content RichText inside a ${"control"} Pressable can't be selected`);
      }
    }
  }
});
