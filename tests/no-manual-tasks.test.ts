import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * due-by-fact (invariant 83), the agent-facing clause. 2026-11-23: PR 2 ended "Manual" in the tool, hook and recovery
 * text, but skills/follow-up/SKILL.md still told agents "Tasks are manual unless explicitly scheduled" and "trigger=null
 * makes a task manual", so the agent read two rules. No text an agent (or a design pass) reads calls a task manual: a
 * task comes due by fact. Scoped to the word "manual" in a sentence about tasks or triggers; "manually maintained", a
 * repair the developer holds back ("Auto off", `manualTasks`) and the sweep's "manual" trigger are other things.
 */
const AGENT_TEXT = [
  "skills/follow-up/SKILL.md", "OVERVIEW.md", "docs/data-access.md", "PRODUCT.md",
  "server/mcp.mjs", "server/agent-hook.mjs", "server/overseer-prompt-source.ts", "server/overseer.ts",
  "server/tasks.ts", "server/recovery-config.ts", "server/agent-hooks.ts", "server/job-agent.ts",
];
const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n/);
const callsATaskManual = (s: string) => /\bmanual\b/i.test(s) && /\b(tasks?|triggers?|obligations?)\b/i.test(s) && !/\bmanualTasks\b|held as manual|"manual" \|/.test(s);

test("due-by-fact: no agent-facing text calls a task manual", async () => {
  const found: string[] = [];
  for (const file of AGENT_TEXT) {
    const text = await readFile(join(import.meta.dirname, "..", file), "utf8");
    for (const s of sentences(text)) if (callsATaskManual(s)) found.push(`${file}: ${s.trim().slice(0, 140)}`);
  }
  assert.deepEqual(found, [], "a task comes due by fact (afterPrs at dependencyStage, or recheck); it is never manual");
});

test("due-by-fact: the skill tells agents what the tool says", async () => {
  const skill = await readFile(join(import.meta.dirname, "..", "skills/follow-up/SKILL.md"), "utf8");
  const mcp = await readFile(join(import.meta.dirname, "..", "server/mcp.mjs"), "utf8");
  const rule = "A task comes due by itself when its afterPrs reach dependencyStage, or on recheck";
  assert.ok(mcp.includes(rule) && skill.includes(rule), "one rule in both places");
  assert.match(skill, /trigger=null removes it\./);
});
