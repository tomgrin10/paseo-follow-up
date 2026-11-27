import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Regression: the fixed row-menu overlay measured the window, but the host clipped it to the sidebar above its footer.
test("menus-stay-visible: every floating menu uses the shared visibility boundary", async () => {
  for (const file of ["row-menu", "home-chrome", "review-mode", "more-context", "catch-up"]) {
    const src = await readFile(new URL(`../client/${file}.tsx`, import.meta.url), "utf8");
    assert.match(src, /<FloatingSurface\b/, `${file}: use the shared bounded overlay, not a local positioned popover`);
  }
});

import { floatingPlacement } from "../shared/floating";
test("menus-stay-visible: flip, shift and bound every side, including a small visual viewport", () => {
  for (const viewport of [{ x: 0, y: 0, width: 1280, height: 720 }, { x: 30, y: 80, width: 240, height: 160 }]) {
    for (const side of ["point", "above", "below", "top-right"] as const) for (const x of [-10, 40, 1200]) for (const y of [0, 100, 700]) {
      const at = floatingPlacement({ x, y, width: 30, height: 32 }, { width: 340, height: 400 }, viewport, side);
      assert.ok(at.left >= viewport.x && at.left + at.width <= viewport.x + viewport.width);
      assert.ok(at.top >= viewport.y && at.top + Math.min(400, at.maxHeight) <= viewport.y + viewport.height);
    }
  }
  const vp = { x: 0, y: 0, width: 1000, height: 700 };
  assert.deepEqual(floatingPlacement({ x: 900, y: 600, width: 0, height: 0 }, { width: 256, height: 300 }, vp), { left: 644, top: 300, width: 256, maxHeight: 684 });
});

test("menus-stay-visible: custom floating surfaces cannot silently bypass the shared overlay", async () => {
  const { readdir } = await import("node:fs/promises");
  const root = new URL("../client/", import.meta.url);
  for (const file of await readdir(root)) {
    if (!file.endsWith(".tsx")) continue;
    const src = await readFile(new URL(file, root), "utf8");
    const localMenus = [...src.matchAll(/<View\b[^>]*(?:accessibilityRole|role)="menu"[^>]*style=\{\{[^}]*position:\s*"absolute"/g)];
    assert.equal(localMenus.length, 0, `${file}: a locally positioned menu bypasses viewport bounds and the host portal`);
  }
});

import { floatingScopes } from "../shared/floating";
test("portal keyboard ownership stays with its opener, never another mounted surface", () => {
  const ownProbe = {}, otherProbe = {};
  const root = { contains: (n: unknown) => n === ownProbe };
  const popup = (id: string) => ({ contains: () => false, getAttribute: () => id });
  const own = popup("own"), other = popup("other");
  const doc = { querySelectorAll: () => [own, other], getElementById: (id: string) => id === "own" ? ownProbe : otherProbe };
  assert.deepEqual(floatingScopes(root, doc), [root, own]);
});

import { intersectFloatBox } from "../shared/floating";
test("nonmodal help stays inside the visible pane and scrolls within its clipped height", () => {
  const pane = { x: -20, y: 40, width: 340, height: 600 };
  const viewport = { x: 0, y: 0, width: 300, height: 480 };
  const visible = intersectFloatBox(pane, viewport);
  assert.deepEqual(visible, { x: 0, y: 40, width: 300, height: 440 });
  const at = floatingPlacement(pane, { width: 320, height: 600 }, visible, "top-right");
  assert.ok(at.left >= visible.x && at.left + at.width <= visible.x + visible.width);
  assert.ok(at.top >= visible.y && at.top + at.maxHeight <= visible.y + visible.height);
});

test("a nonmodal popup already inside its owner is not queried twice", () => {
  const probe = {};
  const popup = { contains: () => false, getAttribute: () => "probe" };
  const root = { contains: (n: unknown) => n === probe || n === popup };
  assert.deepEqual(floatingScopes(root, { querySelectorAll: () => [popup], getElementById: () => probe }), [root]);
});
