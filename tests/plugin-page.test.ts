import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * plugin-page-is-current (invariant 122). Paseo's plugin listing shows paseo-plugin.json's description and OVERVIEW.md.
 * 2026-11-26, the developer: "Seems too long and not the newest". OVERVIEW still said "(1.4 beta)" at 2.4.1 and the
 * two descriptions differed. One description, opening with README's line; a short OVERVIEW with no release labels,
 * file names or internals (the full data statement is docs/data-access.md).
 */
const read = (f: string) => readFile(resolve(f), "utf8");
const MAX_WORDS = 450;

test("one description, the same in package.json and paseo-plugin.json, opening with README's line", async () => {
  const pkg = JSON.parse(await read("package.json")).description as string;
  const manifest = JSON.parse(await read("paseo-plugin.json")).description as string;
  assert.equal(manifest, pkg, "paseo-plugin.json and package.json carry the same description");
  const opening = /^\*\*(.+?)\*\*\s*$/m.exec(await read("README.md"))?.[1];
  assert.ok(opening, "README opens with a bold line");
  assert.ok(pkg.startsWith(opening), `the description opens with README's "${opening}"`);
  assert.ok(pkg.length <= 200, "the description is one short line");
});

test("OVERVIEW.md is short, opens with README's line and has no release labels, file names or internals", async () => {
  const text = await read("OVERVIEW.md");
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/\]\([^)]*\)/g, "]");
  const words = prose.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= MAX_WORDS, `OVERVIEW.md has ${words} words; the plugin page stays under ${MAX_WORDS}`);
  const opening = /^\*\*(.+?)\*\*\s*$/m.exec(await read("README.md"))?.[1];
  assert.ok(opening && text.includes(opening), "OVERVIEW says what README's opening says");
  const lines = prose.split("\n");
  const bad = (re: RegExp) => lines.filter(l => re.test(l)).map(l => l.trim().slice(0, 120));
  assert.deepEqual(bad(/\(\s*v?\d+(\.\d+)+[^)]*\)|\bv?\d+\.\d+\.\d+-(beta|rc|alpha)\b/i), [], "no version-tagged labels such as (1.4 beta)");
  assert.deepEqual(bad(/\((beta|alpha|preview|experimental)\)|\bbeta\b/i), [], "no beta tags: the page describes what ships");
  assert.deepEqual(bad(/`[^`]*`|plugin-data|\b[\w-]+\.(json|jsonl|mjs|ts|tsx|md)\b/), [], "no file names, state files or code");
});
