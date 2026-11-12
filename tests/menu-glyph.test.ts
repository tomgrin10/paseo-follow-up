import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tom (2026-11-12): in Home's sort menu on a phone, the check on the chosen option (Priority) sat near the top of the
 * two-line item instead of beside it. SortMenu built its own glyph slot (`alignSelf: "flex-start", paddingTop: 2`,
 * a 13px icon at every size) while the row menu built another (centred, scaling with touch). Class fix: one layout,
 * `MenuItemContent` (client/menu-item.tsx), for every menu item's glyph and label (menu-glyphs-center-on-their-item).
 */
const dir = join(import.meta.dirname, "..", "client");

/** Each menuitem element in the client: its file and the JSX from its opening tag to its closing tag. */
async function menuItems() {
  const out: { file: string; body: string }[] = [];
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".tsx"))) {
    const source = await readFile(join(dir, f), "utf8");
    for (const m of source.matchAll(/<(Pressable|View|TouchableOpacity)\b[^>]*?(?:accessibilityRole|role)="menuitem"/g)) {
      const end = source.indexOf(`</${m[1]}>`, m.index);
      out.push({ file: f, body: source.slice(m.index, end < 0 ? undefined : end) });
    }
  }
  return out;
}

test("invariant menu-glyphs-center-on-their-item: every menu item lays out through MenuItemContent", async () => {
  const items = await menuItems();
  const files = new Set(items.map(i => i.file));
  assert.ok(files.has("home-chrome.tsx") && files.has("row-menu.tsx"), `menus found in: ${[...files].join(", ")}`);
  for (const { file, body } of items) {
    assert.match(body, /<MenuItemContent\b/, `${file}: a menu item builds its own glyph slot; use MenuItemContent so its glyph centres on the item`);
    assert.doesNotMatch(body, /flex-start/, `${file}: a flex-start glyph slot sits at the top of a two-line item`);
  }
});

test("the shared glyph slot centres on the item and scales with touch", async () => {
  const source = await readFile(join(dir, "menu-item.tsx"), "utf8");
  const slot = source.match(/testID="menu-glyph" style=\{\{([^}]*)\}\}/)?.[1] ?? "";
  assert.match(slot, /alignSelf: "center"/, "the slot centres on the item, whatever the label's height");
  assert.doesNotMatch(slot, /paddingTop|marginTop|flex-start/, "no nudges that pin it to the first line");
  const sizes = source.match(/export const menuGlyph = [^\n]*slot: touch \? (\d+) : (\d+), size: touch \? (\d+) : (\d+)/)?.slice(1).map(Number);
  assert.ok(sizes, "menuGlyph gives the slot and glyph size for touch and desktop");
  const [slotTouch, slotDesk, sizeTouch, sizeDesk] = sizes;
  assert.ok(sizeTouch > sizeDesk, "the glyph grows on touch, as the text does");
  assert.ok(slotTouch >= sizeTouch && slotDesk >= sizeDesk, "the slot fits its glyph");
});
