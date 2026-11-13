import test from "node:test";
import assert from "node:assert/strict";
import { violations } from "../shared/status-invariants";
import { questionSchema, type Question } from "../shared/questions";
import type { Pr } from "../shared/model";
import { clock, pr, snapshot, workspace } from "./fixtures";

// Invariant a-check-costs-linear-in-its-workspace. 2026-11-13 (live-sized busy window): one status check of the
// 153-PR / 52-question workspace took 20 ms and allocated 4 MB, the worker's biggest allocator after the tick itself.
// The duplicate-question scan tokenized both sides of every pair (O(Q²) tokenizations) and stack order walked parents
// with a linear find inside the sort's comparator (O(n² log n)). A check now tokenizes each question once and reads
// each PR's parent a constant number of times.

const QUESTIONS = 200;
const PRS = 300;
/**
 * How many times one check may read each PR's `parent`. Measured 2026-11-13: 2.0 (one depth pass for each stack order
 * the check builds), twice that for a surface that adds one. main read it 30,326 times per PR on this fixture.
 */
const PARENT_READS_PER_PR = 4;

const WORDS = ["cache", "rollout", "gate", "budget", "schema", "index", "retry", "queue", "token", "ledger", "banner", "export", "import", "mirror", "replica", "quota", "shard", "cursor", "digest", "beacon", "anchor", "harbor", "lantern", "meadow", "orchard", "pebble", "quarry", "ripple", "summit", "thicket", "upland", "valley"];
/** Distinct text per question (no two are duplicates of each other), synthetic words only. */
const words = (i: number, n: number, salt: number) => Array.from({ length: n }, (_, k) => WORDS[(i * 7 + k * 11 + salt) % WORDS.length]).join(" ") + ` v${i}x${salt}`;

function fixture() {
  const prs: Pr[] = Array.from({ length: PRS }, (_, k) => pr({
    key: `example/app#${k + 1}`, number: k + 1, stack: `Stack ${Math.floor(k / 30)}`,
    // Stacks of 30, each PR on the one before it: the depth walk's worst case.
    parent: k % 30 ? `example/app#${k}` : null,
    snapshot: snapshot({ title: `Change ${k + 1}`, url: `https://github.com/example/app/pull/${k + 1}`, state: k % 3 ? "OPEN" : "MERGED" }),
  }));
  const questions: Question[] = Array.from({ length: QUESTIONS }, (_, i) => questionSchema.parse({
    id: `Q${i + 1}`, title: `Decide the ${words(i, 3, 1)}`, question: `Should the ${words(i, 6, 2)} move first?`,
    options: ["A", "B", "C"].map((letter, n) => ({ letter, label: words(i, 3, 3 + n) })), recommend: "A", big: null,
    background: null, links: [], prKey: null, taskId: null, taskRevision: null, askedBy: "main-agent",
    askedAt: new Date(clock - i * 60_000).toISOString(), mode: "keep-building", answer: null, closed: null, via: "ask",
  }));
  return workspace({ prs, questions });
}

test("a-check-costs-linear-in-its-workspace: one status check tokenizes each question's text at most once", () => {
  const w = fixture();
  const texts = new Set(w.questions.flatMap(q => [q.title, q.question, ...q.options.map(o => o.label)]));
  const counts = new Map<string, number>();
  const lower = String.prototype.toLowerCase;
  String.prototype.toLowerCase = function (this: string) { const s = String(this); if (texts.has(s)) counts.set(s, (counts.get(s) ?? 0) + 1); return lower.call(this); };
  try { violations(w, clock); } finally { String.prototype.toLowerCase = lower; }
  const worst = [...counts].sort((a, b) => b[1] - a[1])[0];
  assert.ok(counts.size > 0, "the check reads the questions");
  assert.ok(!worst || worst[1] <= 1, `"${worst?.[0]}" was tokenized ${worst?.[1]} times in one check (${QUESTIONS} questions)`);
});

test("a-check-costs-linear-in-its-workspace: one status check reads each PR's parent a constant number of times", () => {
  const w = fixture();
  let reads = 0;
  w.prs = w.prs.map(p => new Proxy(p, { get(target, key, receiver) { if (key === "parent") reads++; return Reflect.get(target, key, receiver); } }));
  violations(w, clock);
  assert.ok(reads > 0, "the check orders the stacks");
  assert.ok(reads <= PARENT_READS_PER_PR * PRS, `${reads} parent reads for ${PRS} PRs (${(reads / PRS).toFixed(1)} each, bound ${PARENT_READS_PER_PR})`);
});

test("a-check-costs-linear-in-its-workspace: an edited question is compared on its new text, not cached tokens", async () => {
  const { textSimilarity } = await import("../shared/questions");
  const a = { title: "Archive the dormant workspaces", question: "Archive them now?", options: [{ label: "Archive all" }] };
  const b = { title: "Archive the dormant workspaces", question: "Archive them now?", options: [{ label: "Archive all" }] };
  assert.equal(textSimilarity(a, b), 1);
  b.title = "Rename the billing ledger"; b.question = "Which ledger name ships?";
  assert.ok(textSimilarity(a, b) < 0.2, "the edit is seen");
});
