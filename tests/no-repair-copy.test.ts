import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * One word for one thing (2026-11-13, Q49/Q51): what Follow-up sends the agent are "tasks", never "repairs". The UI
 * copy in client/ and shared/ may not say "repair" again. Internal identifiers (the "repairs" batch kind, isRepair,
 * the "repair" headline key) stay: a string literal that is a bare identifier, a comment, or an invariant's `why`
 * (history, never shown) doesn't count.
 */
const ROOTS = ["client", "shared"];
const files = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
});
/** The source without comments: block comments, and line comments that start a line or follow whitespace (not a URL's //). */
const uncommented = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/(^|\s)\/\/.*$/gm, "$1");
/** Every string literal (a template's \${…} code left out) and JSX text run, with the invariants' `why:` history left out. */
export function copyStrings(src: string): string[] {
  const code = uncommented(src).replace(/\bwhy:\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, "why: 0");
  const literals = [...code.matchAll(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map(m => m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, " "));
  const jsx = [...code.matchAll(/>([^<>{}=;()]*[A-Za-z][^<>{}=;()]*)</g)].map(m => m[1]);
  return [...literals, ...jsx];
}
const identifier = (s: string) => /^[\w:.\-/]*$/.test(s.trim());

test("no user-facing copy in client/ or shared/ says repair or repairs (the word is tasks)", () => {
  const hits = ROOTS.flatMap(files).flatMap(f => copyStrings(readFileSync(f, "utf8")).filter(s => /\brepairs?\b/i.test(s) && !identifier(s)).map(s => `${f}: ${s.trim().slice(0, 120)}`));
  assert.deepEqual(hits, []);
});

test("the copy scan catches a repair string and ignores identifiers, comments and invariant history", () => {
  const src = [
    `const a = "Repairs go here.";`,
    `const kind = "repairs"; // repairs are tasks`,
    `/* Send repairs */ const b = <Text>Send 2 repairs</Text>;`,
    `const inv = { id: "x", why: "the panel said \\"4 repairs queued\\"" };`,
    "const line = `${plural(repairs.length, \"task\")} queued`;",
  ].join("\n");
  assert.deepEqual(copyStrings(src).filter(s => /\brepairs?\b/i.test(s) && !identifier(s)), ["Repairs go here.", "Send 2 repairs"]);
});
