import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tom (2026-11-12): search results looked like a second list. ResultRow drew its own row (a group pill, a different
 * height, its own active edge), so a workspace changed shape between Home and search. Class fix: a result is the
 * list's own Row with the hit highlighted on it (search-row-is-the-list-row).
 */
const dir = join(import.meta.dirname, "..", "client");

test("invariant search-row-is-the-list-row: search results render Row; no second row component", async () => {
  const list = await readFile(join(dir, "home-list.tsx"), "utf8");
  const result = list.slice(list.indexOf('case "result":'), list.indexOf('case "ask":'));
  assert.match(result, /<Row /, "a result is the list's Row");
  assert.doesNotMatch(result, /Result[A-Z]?\w*Row|<View|<Pressable/, "nothing else drawn around it");
  for (const f of (await readdir(dir)).filter(f => f.endsWith(".tsx"))) {
    const source = await readFile(join(dir, f), "utf8");
    assert.doesNotMatch(source, /function (ResultRow|GroupChip|Highlighted)\b/, `${f}: a second way to draw a search result`);
    if (f !== "home-list.tsx") assert.doesNotMatch(source, /highlightRuns\(/, `${f}: hits are highlighted only by the list Row`);
  }
});
