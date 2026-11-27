// client-renders-under-native-rules (AGENTS.md invariant 51). 2026-11-18, Tom on 2.2.0-beta.4: "when clicking
// on the context icon button in the catch up on mobile, the whole paseo app crashes". Catch up's More context sheet
// (MoveResult) carried accessibilityRole "dialog", forced past the type with `as never`. React Native's Android view
// manager parses accessibilityRole with AccessibilityRole.fromValue, which throws IllegalArgumentException("Invalid
// accessibility role value: dialog") on the UI thread: a native crash no error boundary can catch, and the web, where
// every render and test ran, accepts the role. The ARIA `role` prop is parsed leniently there (unknown is null).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
async function clientFiles(): Promise<string[]> {
  const out = [join(root, "index.client.tsx")];
  for (const f of await readdir(join(root, "client"), { recursive: true })) if (/\.tsx?$/.test(f)) out.push(join(root, "client", f));
  return out;
}

/** Android's own list: the enum AccessibilityRole.fromValue walks (react-native's ReactAccessibilityDelegate.java). */
async function androidRoles(): Promise<Set<string>> {
  const java = await readFile(join(root, "node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.java"), "utf8");
  const body = java.slice(java.indexOf("public enum AccessibilityRole"));
  const names = body.slice(body.indexOf("{") + 1, body.indexOf(";")).split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  assert.ok(names.includes("button") && names.includes("radiogroup") && !names.includes("dialog"), "read the enum");
  assert.match(body, /throw new IllegalArgumentException\("Invalid accessibility role value: "/, "Android still throws on an unknown role");
  return new Set(names);
}

test("every accessibilityRole the client sets is one Android's view manager knows", async () => {
  const known = await androidRoles();
  const bad: string[] = [];
  for (const f of await clientFiles()) {
    const s = await readFile(f, "utf8");
    for (const m of s.matchAll(/accessibilityRole=\{?["'`]([^"'`]+)["'`]/g)) if (!known.has(m[1].toLowerCase())) bad.push(`${f.slice(root.length)}: ${m[1]}`);
  }
  assert.deepEqual(bad, [], "use the ARIA role prop (role=\"dialog\"), which Android parses leniently");
});

test("no accessibilityRole is cast past its type, the only check that keeps it to Android's list", async () => {
  const bad: string[] = [];
  for (const f of await clientFiles()) {
    const s = await readFile(f, "utf8");
    for (const m of s.matchAll(/accessibilityRole=\{[^}]*\bas\b[^}]*\}/g)) bad.push(`${f.slice(root.length)}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test("Catch up's More context and Later sheets (MoveResult) and the keys sheet are dialogs by the ARIA role", async () => {
  const s = await readFile(join(root, "client/catch-up.tsx"), "utf8");
  const shared = await readFile(join(root, "client/more-context.tsx"), "utf8");
  assert.match(shared, /function MoveResult[\s\S]*?role="dialog" accessibilityLabel=\{label\}/);
  const floating = await readFile(join(root, "client/floating-surface.tsx"), "utf8");
  assert.match(floating, /role = "dialog"/);
  assert.match(floating, /<View[^>]*role=\{role\} aria-label=\{label\}/);
  assert.match(s, /function KeysSheet[\s\S]*?<FloatingSurface[^>]*label=\{label\}/);
});
