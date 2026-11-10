import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FORWARD_PREFIX, FORWARD_PREFIXES, forwardText, isForwarded } from "../shared/overseer";

// Follow-up is a public plugin: what it says to agents, models and the developer never names one person. Comments may
// (they record who asked for what); prompts, prefixes, tool descriptions, receipts and UI copy may not.
const ROOT = join(import.meta.dirname, "..");
const DENY = /\b(Tom|Tom's|Gringauz)\b/; // the repository owner's handle in its URL is an identity, not prose
// The only allowed occurrence: the earlier forward prefix, kept so old transcripts are still recognised.
const LEGACY = ['"From Tom via Overseer:"'];

const shipped = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap(name => {
  const rel = join(dir, name);
  if (statSync(join(ROOT, rel)).isDirectory()) return shipped(rel);
  return /\.(ts|tsx|mjs|md)$/.test(name) ? [rel] : [];
});
/** Blanks comments, keeping line numbers. `//` right after `:` or a quote is a URL or a string, not a comment. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

test("no personal name in anything Follow-up says (prompts, prefixes, tool text, UI)", () => {
  const files = [...shipped("shared"), ...shipped("server"), ...shipped("client"), ...shipped("skills"), "index.server.ts", "index.client.tsx"];
  assert.ok(files.length > 50, "the scan found the sources");
  const hits: string[] = [];
  for (const file of files) {
    const raw = readFileSync(join(ROOT, file), "utf8");
    const text = file.endsWith(".md") ? raw : code(raw);
    text.split("\n").forEach((line, i) => {
      const clean = LEGACY.reduce((l, allowed) => l.split(allowed).join(""), line);
      if (DENY.test(clean)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, [], "say \"the developer\" (they/their) instead");
});

test("the README describes the developer without naming them; only the copyright line names the author", () => {
  const hits = readFileSync(join(ROOT, "README.md"), "utf8").split("\n").map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => DENY.test(line) && !/^\[MIT\]\(LICENSE\) ©/.test(line));
  assert.deepEqual(hits.map(h => `README.md:${h.n}: ${h.line.slice(0, 120)}`), []);
});

test("the Overseer prompt refers to the developer without gendered pronouns", () => {
  const prompt = readFileSync(join(ROOT, "server/overseer-prompt.md"), "utf8");
  assert.equal(/\b(he|him|his|she|her|hers)\b/i.test(prompt), false);
});

test("forwards carry the neutral prefix, and the legacy one is still recognised", () => {
  assert.equal(FORWARD_PREFIX, "From the developer via Overseer:");
  assert.equal(forwardText("use option B"), "From the developer via Overseer: use option B");
  for (const p of FORWARD_PREFIXES) assert.equal(isForwarded(`${p} ship it`), true);
  assert.equal(isForwarded("From Tom via Overseer: old transcript"), true);
  assert.equal(isForwarded("Please ship it"), false);
});
