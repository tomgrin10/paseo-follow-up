import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Paseo 0.16 draws a chevron on popover pills. Follow-up switched its pill to an action pill for the 6 s undo window,
// so the chevron and the pill's width jumped on every sign-off. A composer pill keeps one kind for its life: a popover,
// with Undo inside it. Same on 0.15, which draws no chevron.
test("the composer pill is always a popover; Undo lives inside it", async () => {
  const source = await readFile(join(import.meta.dirname, "..", "client", "pill.tsx"), "utf8");
  assert.doesNotMatch(source, /kind:\s*"action"/, "a composer pill must not switch to an action pill");
  assert.match(source, /behavior: \{ kind: "popover" as const, Content \}/);
  assert.match(source, /state\?\.mode === "undo"[\s\S]{0,800}title="Undo"[\s\S]{0,200}inbox\.undo\(\[agentId\]\)/, "the popover offers Undo in the undo window");
});
